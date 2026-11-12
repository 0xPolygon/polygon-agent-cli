import { useCallback, useEffect, useRef, useState } from 'react';

import type { LoginAction, MachineEvent, MachineState, RelayStatus } from './machine.js';

import { oidcRelayUrl } from '../config';
import { AuthPending } from './AuthPending.js';
import { EmailForm } from './EmailForm.js';
import { LinkExpired } from './LinkExpired.js';
import { LoginShell } from './LoginShell.js';
import { LOGIN_LINE, initialState, reduce } from './machine.js';
import { MethodChoice } from './MethodChoice.js';
import { NoSession } from './NoSession.js';
import { OtpForm } from './OtpForm.js';
import { getSessionId, isRelayReturn } from './returnUrl.js';
import { SignedIn } from './SignedIn.js';
import { SignInFailed } from './SignInFailed.js';
import { Waiting } from './Waiting.js';

// Poll fast while waiting on the CLI (returning from the provider, checking a
// code) so the transition to the dashboard feels immediate; poll slower while
// waiting on the user, to keep idle load light.
const ACTIVE_POLL_MS = 600;
const IDLE_POLL_MS = 1200;
const ACTIVE_WAIT: MachineState['kind'][] = [
  'google-wait',
  'auth-pending',
  'email-wait',
  'otp-wait'
];

// Post-login destination: the dashboard in this same app, wallet prefilled.
// Same-origin, so it tracks whichever environment served the login page.
function dashboardUrl(walletAddress: string): string {
  return `/?wallet=${walletAddress}&chain=137`;
}

// Optimistic ui transitions must only happen after the relay has acknowledged
// the action. Returns true only when the POST actually landed, so call sites
// can stay put and let the user retry when it did not.
async function postAction(session: string, action: LoginAction): Promise<boolean> {
  try {
    const res = await fetch(`${oidcRelayUrl}/api/login/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session, action })
    });
    return res.ok || res.status === 204;
  } catch {
    return false;
  }
}

// A transient relay failure (network error or a 5xx) must not terminate the
// session, so it returns null and the polling effect just skips that tick.
// Only a 400 (an invalid session id, which never becomes valid) maps to the
// terminal expired state.
async function fetchStatus(session: string): Promise<RelayStatus | null> {
  try {
    const res = await fetch(
      `${oidcRelayUrl}/api/login/status?session=${encodeURIComponent(session)}`
    );
    if (res.ok) return (await res.json()) as RelayStatus;
    if (res.status === 400) return { status: 'expired' };
    return null;
  } catch {
    return null;
  }
}

const TERMINAL: MachineState['kind'][] = ['success', 'expired', 'failed'];

// The OMS relay return URI is now the bare, static `/login` (required to
// match its allowlist exactly), so it can no longer carry the pairing
// session as a query param. Instead, the session is stashed here before the
// redirect to Google and recovered from here on the bounce back, since a
// sessionStorage entry survives that round trip on the same origin.
const SESSION_STORE_KEY = 'oms_login_session';

export function LoginPage() {
  const relayReturn = isRelayReturn(window.location.search);
  // Resolve the session from the url first (fresh CLI announce, or the
  // legacy `?s=` shape); fall back to whatever was stashed before the
  // redirect to Google. Runs once per mount via the lazy state initializer,
  // so the sessionStorage write on a fresh url load never thrashes.
  const [session] = useState<string>(() => {
    const fromUrl = getSessionId(window.location.search, window.location.hash);
    if (fromUrl) {
      try {
        window.sessionStorage.setItem(SESSION_STORE_KEY, fromUrl);
      } catch {
        // Best-effort: storage may be unavailable (private browsing, etc).
        // This load still has the session; it just won't survive a redirect.
      }
      return fromUrl;
    }
    try {
      return window.sessionStorage.getItem(SESSION_STORE_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [state, setState] = useState<MachineState>(() =>
    relayReturn ? reduce(initialState, { type: 'relay-return' }) : initialState
  );
  const dispatch = useCallback((event: MachineEvent) => {
    setState((s) => reduce(s, event));
  }, []);
  const redirected = useRef(false);
  const postedRelayCallback = useRef(false);

  // On return from the OMS relay, hand the full callback url back to the CLI
  // over the pairing channel once; the CLI exchanges it for the wallet and
  // publishes `done`, which the poll below picks up like any other status.
  // A failed post (a network error, or a 410 for a session that already
  // expired) must not leave the user stuck on the "finishing sign in"
  // spinner until the ~10-minute poll timeout, so a false result dispatches
  // the terminal failed state right away. If the session could not be
  // recovered at all (sessionStorage empty, e.g. a different browser or a
  // cleared session), there is nothing to post against, so it fails fast
  // instead of posting an empty session to the relay.
  useEffect(() => {
    if (postedRelayCallback.current || !relayReturn) return;
    postedRelayCallback.current = true;
    if (!session) {
      dispatch({
        type: 'status',
        status: {
          status: 'error',
          message: 'Could not recover the login session. Re-run wallet login in your terminal.'
        }
      });
      return;
    }
    void postAction(session, { type: 'oidc-callback', callbackUrl: window.location.href }).then(
      (ok) => {
        if (ok) return;
        dispatch({
          type: 'status',
          status: {
            status: 'error',
            message: 'Could not reach the login relay. Re-run wallet login in your terminal.'
          }
        });
      }
    );
  }, [session, relayReturn, dispatch]);

  // Once the session is established the user should land on their dashboard
  // without another click; the success card shows briefly, then we move on.
  useEffect(() => {
    if (state.kind !== 'success') return;
    // With a funding link to offer, stay put so it can be used.
    if (state.funding) return;
    const target = dashboardUrl(state.walletAddress);
    const timer = setTimeout(() => window.location.assign(target), 1800);
    return () => clearTimeout(timer);
  }, [state]);

  // Poll the relay for CLI-published status; redirect once when the auth url
  // arrives (a side effect the reducer deliberately does not model).
  useEffect(() => {
    if (!session || TERMINAL.includes(state.kind)) return;
    const timer = setInterval(
      () => {
        void fetchStatus(session).then((status) => {
          if (status === null) return; // transient failure; keep polling
          if (status.status === 'auth-url' && !redirected.current && state.kind === 'google-wait') {
            redirected.current = true;
            window.location.assign(status.url);
            return;
          }
          dispatch({ type: 'status', status });
        });
      },
      ACTIVE_WAIT.includes(state.kind) ? ACTIVE_POLL_MS : IDLE_POLL_MS
    );
    return () => clearInterval(timer);
  }, [session, state.kind, dispatch]);

  if (!session) {
    return (
      <LoginShell>
        <NoSession />
      </LoginShell>
    );
  }

  return <LoginShell>{renderState(state, session, dispatch)}</LoginShell>;
}

function renderState(state: MachineState, session: string, dispatch: (e: MachineEvent) => void) {
  switch (state.kind) {
    case 'method':
      return (
        <MethodChoice
          line={LOGIN_LINE}
          onGoogle={() => {
            void postAction(session, { type: 'google' }).then((ok) => {
              if (ok) dispatch({ type: 'choose-google' });
            });
          }}
          onEmail={() => dispatch({ type: 'choose-email' })}
        />
      );
    case 'google-wait':
      return <Waiting text="Sending you to Google sign in" />;
    case 'auth-pending':
      return <AuthPending url={state.url} />;
    case 'email-entry':
      return (
        <EmailForm
          onSubmit={(email) => {
            void postAction(session, { type: 'email', email }).then((ok) => {
              if (ok) dispatch({ type: 'submit-email', email });
            });
          }}
          onBack={() => dispatch({ type: 'back' })}
        />
      );
    case 'email-wait':
      return <Waiting text="Sending a sign in code to your inbox" />;
    case 'otp-entry':
      return (
        <OtpForm
          invalid={state.invalid}
          attemptsLeft={state.attemptsLeft}
          onSubmit={(code) => {
            void postAction(session, { type: 'otp', code }).then((ok) => {
              if (ok) dispatch({ type: 'submit-otp', code });
            });
          }}
        />
      );
    case 'otp-wait':
      return <Waiting text="Checking your code" />;
    case 'success':
      return (
        <SignedIn
          walletAddress={state.walletAddress}
          dashboardHref={dashboardUrl(state.walletAddress)}
          fundingUrl={state.funding?.url}
        />
      );
    case 'expired':
      return <LinkExpired />;
    case 'failed':
      return <SignInFailed message={state.message} />;
  }
}

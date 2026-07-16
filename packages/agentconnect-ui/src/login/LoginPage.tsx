import { useCallback, useEffect, useRef, useState } from 'react';

import type { LoginAction, MachineEvent, MachineState, RelayStatus } from './machine.js';

import { LogoBadge } from '../App.js';
import { oidcRelayUrl } from '../config';
import { initialState, reduce } from './machine.js';

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

// Session id lives in the `?s=` query param (used for the OMS relay return
// URI, since fragments may be consumed by the relay); the `#` fragment is
// kept as a fallback for older announce links.
function getSessionId(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('s');
  if (fromQuery) return fromQuery;
  return window.location.hash.slice(1);
}

// True when this load is the browser bouncing back from the OMS relay after
// Google sign-in, not a fresh open. The CLI's announce URL is a bare
// `/login#<session>` fragment with no query string at all, so any query key
// besides `s` showing up alongside it means the OMS relay appended its own
// callback params on the way back.
function isRelayReturn(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (!params.get('s')) return false;
  for (const key of params.keys()) {
    if (key !== 's') return true;
  }
  return false;
}

export function LoginPage() {
  const session = getSessionId();
  const [state, setState] = useState<MachineState>(() =>
    isRelayReturn() ? reduce(initialState, { type: 'relay-return' }) : initialState
  );
  const dispatch = useCallback((event: MachineEvent) => {
    setState((s) => reduce(s, event));
  }, []);
  const redirected = useRef(false);
  const postedRelayCallback = useRef(false);

  // On return from the OMS relay, hand the full callback url back to the CLI
  // over the pairing channel once; the CLI exchanges it for the wallet and
  // publishes `done`, which the poll below picks up like any other status.
  useEffect(() => {
    if (postedRelayCallback.current || !session || !isRelayReturn()) return;
    postedRelayCallback.current = true;
    void postAction(session, { type: 'oidc-callback', callbackUrl: window.location.href });
  }, [session]);

  // Once the session is established the user should land on their dashboard
  // without another click; the success card shows briefly, then we move on.
  useEffect(() => {
    if (state.kind !== 'success') return;
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
      <Shell>
        <h1 className="text-xl font-semibold text-[#141635]">No login session</h1>
        <p className="mt-2 text-sm text-[#64708f]">
          Open this page from the polygon-agent CLI: run
          <code className="mx-1 rounded bg-[#eef0f8] px-1.5 py-0.5 text-xs">
            agent wallet login
          </code>
          in your terminal.
        </p>
      </Shell>
    );
  }

  return <Shell>{renderState(state, session, dispatch)}</Shell>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#f5f6fb] flex flex-col items-center justify-center px-4">
      <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[99999]">
        <LogoBadge />
      </div>
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-[0_2px_8px_rgba(20,22,53,0.06)] border border-[#e3e7f2]">
        {children}
      </div>
    </div>
  );
}

function renderState(state: MachineState, session: string, dispatch: (e: MachineEvent) => void) {
  switch (state.kind) {
    case 'method':
      return (
        <MethodChoice
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
      return (
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-[#c8cfe1] border-t-[#141635]" />
          <p className="mt-4 text-sm text-[#64708f]">Finishing sign in</p>
          {state.url && (
            <a
              href={state.url}
              className="mt-6 inline-block text-sm text-[#64708f] hover:text-[#141635] underline"
            >
              Not redirected? Continue with Google
            </a>
          )}
        </div>
      );
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
        <div className="text-center">
          <h1 className="text-xl font-semibold text-[#141635]">You're signed in</h1>
          <p className="mt-2 text-sm text-[#64708f] break-all">Wallet {state.walletAddress}</p>
          <p className="mt-2 text-sm text-[#64708f]">
            Your terminal session is ready. Taking you to your dashboard.
          </p>
          <a
            href={dashboardUrl(state.walletAddress)}
            className="mt-6 inline-block text-sm text-[#64708f] hover:text-[#141635] underline"
          >
            Not redirected? Open your dashboard
          </a>
        </div>
      );
    case 'expired':
      return (
        <div className="text-center">
          <h1 className="text-xl font-semibold text-[#141635]">This link has expired</h1>
          <p className="mt-2 text-sm text-[#64708f]">
            Run{' '}
            <code className="rounded bg-[#eef0f8] px-1.5 py-0.5 text-xs">agent wallet login</code>{' '}
            again to get a fresh link.
          </p>
        </div>
      );
    case 'failed':
      return (
        <div className="text-center">
          <h1 className="text-xl font-semibold text-[#141635]">Sign in failed</h1>
          <p className="mt-2 text-sm text-[#64708f]">{state.message}</p>
          <p className="mt-2 text-sm text-[#64708f]">
            Check your terminal for details and re-run the login.
          </p>
        </div>
      );
  }
}

function GoogleLogo() {
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

function MethodChoice({ onGoogle, onEmail }: { onGoogle: () => void; onEmail: () => void }) {
  return (
    <div>
      <h1 className="text-xl font-semibold text-[#141635] text-center">
        Sign in to your agent wallet
      </h1>
      <p className="mt-2 text-sm text-[#64708f] text-center">
        This connects to your agent in your terminal.
      </p>
      <button
        onClick={onGoogle}
        className="mt-6 w-full rounded-xl bg-[#141635] px-5 py-3 text-sm font-medium text-white hover:bg-[#1e2155] flex items-center justify-center gap-2.5"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white">
          <GoogleLogo />
        </span>
        Continue with Google
      </button>
      <button
        onClick={onEmail}
        className="mt-3 w-full rounded-xl border border-[#c8cfe1] px-5 py-3 text-sm font-medium text-[#141635] hover:bg-[#f5f6fb]"
      >
        Continue with email
      </button>
    </div>
  );
}

function EmailForm({
  onSubmit,
  onBack
}: {
  onSubmit: (email: string) => void;
  onBack: () => void;
}) {
  const [email, setEmail] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (email.includes('@')) onSubmit(email.trim());
      }}
    >
      <h1 className="text-xl font-semibold text-[#141635] text-center">Sign in with email</h1>
      <input
        type="email"
        required
        autoFocus
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        className="mt-6 w-full rounded-xl border border-[#c8cfe1] px-4 py-3 text-sm text-[#141635] outline-none focus:border-[#141635]"
      />
      <button
        type="submit"
        className="mt-4 w-full rounded-xl bg-[#141635] px-5 py-3 text-sm font-medium text-white hover:bg-[#1e2155]"
      >
        Send code
      </button>
      <button
        type="button"
        onClick={onBack}
        className="mt-3 w-full text-sm text-[#64708f] hover:text-[#141635]"
      >
        Back
      </button>
    </form>
  );
}

function OtpForm({
  invalid,
  attemptsLeft,
  onSubmit
}: {
  invalid?: boolean;
  attemptsLeft?: number;
  onSubmit: (code: string) => void;
}) {
  const [code, setCode] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (code.trim().length >= 4) onSubmit(code.trim());
      }}
    >
      <h1 className="text-xl font-semibold text-[#141635] text-center">Enter your code</h1>
      <p className="mt-2 text-sm text-[#64708f] text-center">
        We sent a one-time code to your email.
      </p>
      {invalid && (
        <p className="mt-2 text-sm text-[#d92d20] text-center">
          That code didn't work
          {typeof attemptsLeft === 'number' ? ` (${attemptsLeft} attempts left)` : ''}. Try again.
        </p>
      )}
      <input
        inputMode="numeric"
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="123456"
        className="mt-6 w-full rounded-xl border border-[#c8cfe1] px-4 py-3 text-center text-lg tracking-[0.3em] text-[#141635] outline-none focus:border-[#141635]"
      />
      <button
        type="submit"
        className="mt-4 w-full rounded-xl bg-[#141635] px-5 py-3 text-sm font-medium text-white hover:bg-[#1e2155]"
      >
        Verify
      </button>
    </form>
  );
}

function Waiting({ text }: { text: string }) {
  return (
    <div className="text-center">
      <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-[#c8cfe1] border-t-[#141635]" />
      <p className="mt-4 text-sm text-[#64708f]">{text}</p>
    </div>
  );
}

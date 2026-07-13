import { useCallback, useEffect, useRef, useState } from 'react';

import type { LoginAction, MachineEvent, MachineState, RelayStatus } from './machine.js';

import { LogoBadge } from '../App.js';
import { oidcRelayUrl } from '../config';
import { initialState, reduce } from './machine.js';

const WALLET_URL = 'https://wallet.polygon.technology';
const POLL_MS = 1500;

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

export function LoginPage() {
  const session = window.location.hash.slice(1);
  const [state, setState] = useState<MachineState>(initialState);
  const dispatch = useCallback((event: MachineEvent) => {
    setState((s) => reduce(s, event));
  }, []);
  const redirected = useRef(false);

  // Poll the relay for CLI-published status; redirect once when the auth url
  // arrives (a side effect the reducer deliberately does not model).
  useEffect(() => {
    if (!session || TERMINAL.includes(state.kind)) return;
    const timer = setInterval(() => {
      void fetchStatus(session).then((status) => {
        if (status === null) return; // transient failure; keep polling
        if (status.status === 'auth-url' && !redirected.current && state.kind === 'google-wait') {
          redirected.current = true;
          window.location.assign(status.url);
          return;
        }
        dispatch({ type: 'status', status });
      });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [session, state.kind, dispatch]);

  if (!session) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold text-[#141635]">No login session</h1>
        <p className="mt-2 text-sm text-[#64708f]">
          Open this page from the polygon-agent CLI: run
          <code className="mx-1 rounded bg-[#eef0f8] px-1.5 py-0.5 text-xs">
            polygon-agent wallet login
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
          onCancel={() => {
            // The CLI consumes the cancel, publishes an error status, and exits;
            // the next poll moves this page to the failed state.
            void postAction(session, { type: 'cancel' });
          }}
        />
      );
    case 'google-wait':
      return <Waiting text="Sending you to Google sign in" />;
    case 'auth-pending':
      return (
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-[#c8cfe1] border-t-[#141635]" />
          <p className="mt-4 text-sm text-[#64708f]">Finishing sign in</p>
          <a
            href={state.url}
            className="mt-6 inline-block text-sm text-[#64708f] hover:text-[#141635] underline"
          >
            Not redirected? Continue with Google
          </a>
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
            Your terminal session is ready. You can close this tab.
          </p>
          <a
            href={WALLET_URL}
            className="mt-6 inline-block rounded-xl bg-[#141635] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#1e2155]"
          >
            Manage your wallet
          </a>
        </div>
      );
    case 'expired':
      return (
        <div className="text-center">
          <h1 className="text-xl font-semibold text-[#141635]">This link has expired</h1>
          <p className="mt-2 text-sm text-[#64708f]">
            Run{' '}
            <code className="rounded bg-[#eef0f8] px-1.5 py-0.5 text-xs">
              polygon-agent wallet login
            </code>{' '}
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

function MethodChoice({
  onGoogle,
  onEmail,
  onCancel
}: {
  onGoogle: () => void;
  onEmail: () => void;
  onCancel: () => void;
}) {
  return (
    <div>
      <h1 className="text-xl font-semibold text-[#141635] text-center">
        Sign in to your agent wallet
      </h1>
      <p className="mt-2 text-sm text-[#64708f] text-center">
        This connects the polygon-agent CLI in your terminal.
      </p>
      <button
        onClick={onGoogle}
        className="mt-6 w-full rounded-xl bg-[#141635] px-5 py-3 text-sm font-medium text-white hover:bg-[#1e2155]"
      >
        Continue with Google
      </button>
      <button
        onClick={onEmail}
        className="mt-3 w-full rounded-xl border border-[#c8cfe1] px-5 py-3 text-sm font-medium text-[#141635] hover:bg-[#f5f6fb]"
      >
        Continue with email
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="mt-3 w-full text-sm text-[#64708f] hover:text-[#141635]"
      >
        Cancel this login
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

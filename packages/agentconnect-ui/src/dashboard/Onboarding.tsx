import { ArrowDownLeft, Target, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';

import { LogoBadge } from '../App.js';
import { finishEmail, finishGoogle, startEmail, startGoogle } from './signin.js';
import { IconTile } from './ui.js';

// An illustration of the dashboard, not the visitor's data.
const PREVIEW_ROWS = [
  {
    icon: Target,
    title: 'Predicted Yes on "Fed cuts rates in December?"',
    kind: 'Prediction',
    amount: '-$5.00'
  },
  { icon: Zap, title: 'Paid for 14 web searches', kind: 'Pay per use', amount: '-$0.28' },
  { icon: ArrowDownLeft, title: 'Received 50 USDC', kind: 'Deposit', amount: '+$50.00' }
];

function Heading({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="m-0 text-[34px] md:text-[44px] leading-[1.1] font-bold tracking-[-0.02em]">
        {title}
      </h1>
      <p className="m-0 text-lg leading-snug text-[var(--slate-600)]">{children}</p>
    </div>
  );
}

const inputClass =
  'h-12 border border-[var(--slate-300)] rounded-xl px-3.5 text-base bg-white outline-none focus:border-[var(--purple-500)]';

export function SignIn({
  finishing,
  onSignedIn
}: {
  finishing: boolean;
  onSignedIn: (wallet: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(finishing);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (finishing) void run(async () => onSignedIn(await finishGoogle()));
  }, [finishing]);

  return (
    <div className="flex flex-col gap-6">
      <Heading title="A wallet your agent can spend from">
        Add your details once. Then let any agent you use shop, predict, and earn for you, within a
        limit you set.
      </Heading>

      {finishing && busy ? (
        <span className="text-base text-[var(--slate-600)]">Signing you in…</span>
      ) : !sent ? (
        <form
          className="flex flex-col gap-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await startEmail(email.trim());
              setSent(true);
            });
          }}
        >
          <label htmlFor="email" className="text-sm font-medium text-[var(--slate-600)]">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className={inputClass}
          />
          <button type="submit" disabled={busy} className="btn btn-primary btn-lg w-full h-12">
            {busy ? 'Sending code…' : 'Continue with email'}
          </button>
        </form>
      ) : (
        <form
          className="flex flex-col gap-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => onSignedIn(await finishEmail(code.trim())));
          }}
        >
          <label htmlFor="code" className="text-sm font-medium text-[var(--slate-600)]">
            Enter the code we sent to {email}
          </label>
          <input
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            className={`${inputClass} tracking-[0.2em]`}
          />
          <button type="submit" disabled={busy} className="btn btn-primary btn-lg w-full h-12">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <button
            type="button"
            onClick={() => {
              setSent(false);
              setCode('');
            }}
            className="btn btn-ghost btn-lg w-full h-11 text-[var(--slate-500)]"
          >
            Use a different email
          </button>
        </form>
      )}

      {!sent && !(finishing && busy) && (
        <>
          <div className="flex items-center gap-3 text-[13px] text-[var(--slate-400)]">
            <div className="flex-1 h-px bg-[var(--slate-200)]" />
            or
            <div className="flex-1 h-px bg-[var(--slate-200)]" />
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(startGoogle)}
            className="btn btn-secondary btn-lg w-full h-12 bg-white"
          >
            Continue with Google
          </button>
        </>
      )}

      {error && <span className="text-sm text-[var(--red-700)] font-medium">{error}</span>}
    </div>
  );
}

// A page that asked the owner to sign in (approving an agent's request) and
// wants them back after a Google sign-in, which returns to /login.
export const RETURN_KEY = 'agentconnect_return';

function takeReturnPath(): string {
  try {
    const path = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    // Only a path on this site.
    return path && path.startsWith('/') && !path.startsWith('//') ? path : '/';
  } catch {
    return '/';
  }
}

/**
 * Shown when the page is opened without a wallet: sign in, then straight to the
 * dashboard. `finishing` is set on the Google return to `/login`.
 */
export function Onboarding({ finishing = false }: { finishing?: boolean }) {
  return (
    <div className="min-h-[100dvh] flex flex-col bg-[var(--slate-50)] text-[var(--slate-900)]">
      <div className="h-16 flex items-center px-6 bg-white border-b border-[var(--slate-200)]">
        <LogoBadge />
      </div>
      <div className="flex-1 grid md:grid-cols-2 gap-12 max-w-[1120px] w-full mx-auto px-5 pt-7 pb-10 md:px-10 md:py-12 items-center">
        <div className="flex flex-col gap-7 max-w-[460px] w-full min-w-0">
          <SignIn
            finishing={finishing}
            onSignedIn={() => window.location.assign(takeReturnPath())}
          />
        </div>

        <div className="hidden md:flex bg-white border border-[var(--slate-200)] rounded-3xl p-7 flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <span className="text-sm text-[var(--slate-500)]">Balance</span>
            <span className="text-[40px] font-bold tracking-[-0.02em]">$245.72</span>
          </div>
          <div className="h-px bg-[var(--slate-100)]" />
          <span className="text-sm font-bold text-[var(--slate-600)]">
            What your agents did today
          </span>
          <div className="flex flex-col gap-1">
            {PREVIEW_ROWS.map((r) => (
              <div key={r.title} className="flex items-center gap-3 py-2.5">
                <IconTile icon={r.icon} size={36} />
                <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <span className="text-[15px] font-bold">{r.title}</span>
                  <span className="text-[13px] text-[var(--slate-500)]">{r.kind}</span>
                </span>
                <span
                  className="text-[15px] font-bold"
                  style={{ color: r.amount.startsWith('+') ? 'var(--emerald-700)' : undefined }}
                >
                  {r.amount}
                </span>
              </div>
            ))}
          </div>
          <div className="bg-[var(--slate-50)] rounded-xl px-4 py-3.5 flex justify-between text-sm">
            <span className="text-[var(--slate-600)]">Spending limit</span>
            <span className="font-bold">$5.28 of $200 used</span>
          </div>
        </div>
      </div>
    </div>
  );
}

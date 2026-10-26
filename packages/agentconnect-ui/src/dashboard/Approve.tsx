import { useEffect, useState } from 'react';

import { LogoBadge } from '../App.js';
import { currentSession } from './signin.js';

// Set while a Google sign-in for an approval is out at the relay: the sign-in
// id and the approval page to come back to.
export const APPROVE_KEY = 'agentconnect_approve';

export function isApproveReturn(): boolean {
  try {
    return !!sessionStorage.getItem(APPROVE_KEY);
  } catch {
    return false;
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(data.message ?? 'Something went wrong. Try again.');
  return data;
}

const inputClass =
  'h-12 border border-[var(--slate-300)] rounded-xl px-3.5 text-base bg-white outline-none focus:border-[var(--purple-500)]';

// Signing in on the approval page: keeps the owner signed in to their wallet
// until they answer, since some requests run from it.
function ApproveSignIn({ base, onSignedIn }: { base: string; onSignedIn: (c: string) => void }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [c, setC] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
  return (
    <div className="flex flex-col gap-3">
      {!c ? (
        <form
          className="flex flex-col gap-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              setC(
                (await post<{ c: string }>(`${base}/signin/email/start`, { email: email.trim() })).c
              );
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
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await post<{ c: string; url: string }>(`${base}/signin/google/start`, {});
                sessionStorage.setItem(
                  APPROVE_KEY,
                  JSON.stringify({
                    c: r.c,
                    path: window.location.pathname + window.location.search
                  })
                );
                window.location.assign(r.url);
              })
            }
            className="btn btn-secondary btn-lg w-full h-12 bg-white"
          >
            Continue with Google
          </button>
        </form>
      ) : (
        <form
          className="flex flex-col gap-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await post(`${base}/signin/email/finish`, { c, code: code.trim() });
              onSignedIn(c);
            });
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
            {busy ? 'Signing in…' : 'Continue'}
          </button>
        </form>
      )}
      {error && <span className="text-sm text-[var(--red-700)] font-medium">{error}</span>}
    </div>
  );
}

interface Action {
  actionId: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'declined' | 'expired';
  title: string;
  details: { label: string; value: string }[];
  appName: string;
  expiresAt: string;
  // It runs from the owner's wallet: approving needs a sign-in on this page.
  ownerSignIn?: boolean;
  error?: { error: string };
}

const DONE: Record<Exclude<Action['status'], 'pending' | 'running'>, string> = {
  done: 'Approved. Your agent can carry on.',
  failed: "Approved, but it didn't go through.",
  declined: 'Declined. Nothing was spent.',
  expired: 'This request expired. Nothing was spent.'
};

/**
 * An agent's request to spend, from an app that has the owner approve each one
 * (ChatGPT). The owner, signed in on this site, sees what it does and approves
 * or declines it. Approving runs it here.
 */
export function Approve({ finishing = false }: { finishing?: boolean }) {
  const [returning] = useState(() => {
    if (!finishing) return null;
    try {
      const r = JSON.parse(sessionStorage.getItem(APPROVE_KEY) ?? 'null') as {
        c: string;
        path: string;
      } | null;
      sessionStorage.removeItem(APPROVE_KEY);
      return r;
    } catch {
      return null;
    }
  });
  const params = new URLSearchParams(
    returning ? new URL(returning.path, window.location.origin).search : window.location.search
  );
  const path = `/api/actions/${encodeURIComponent(params.get('k') ?? '')}/${encodeURIComponent(params.get('a') ?? '')}`;
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  // The sign-in on this page, kept for approving.
  const [c, setC] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const res = await fetch(path);
    const data = (await res.json().catch(() => ({}))) as Action & { message?: string };
    if (!res.ok) throw new Error(data.message ?? 'This request was not found.');
    setAction(data);
  };

  useEffect(() => {
    void (async () => {
      if (returning) {
        try {
          await post(`${path}/signin/google/finish`, {
            c: returning.c,
            callbackUrl: window.location.href
          });
          setC(returning.c);
        } catch (e) {
          setError(e instanceof Error ? e.message : 'That sign-in did not work.');
        }
        window.history.replaceState(null, '', returning.path);
      }
      const s = await currentSession();
      setSignedIn(!!s);
      if (s) await load().catch((e: Error) => setError(e.message));
    })();
    // Runs once, on load.
  }, []);

  const signedInHere = async (id: string) => {
    setC(id);
    setSignedIn(true);
    await load().catch((e: Error) => setError(e.message));
  };

  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve, ...(c ? { c } : {}) })
      });
      const data = (await res.json().catch(() => ({}))) as Action & { message?: string };
      // The sign-in kept from connecting ran out: the page asks for one now.
      if ((data as { error?: unknown }).error === 'owner_signin_needed') await load();
      if (!res.ok) throw new Error(data.message ?? 'Something went wrong. Try again.');
      setAction(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-[100dvh] flex flex-col bg-[var(--slate-50)] text-[var(--slate-900)]">
      <div className="h-16 flex items-center px-6 bg-white border-b border-[var(--slate-200)]">
        <LogoBadge />
      </div>
      <div className="flex-1 flex items-center justify-center px-5 py-10">
        <div className="w-full max-w-[420px] flex flex-col gap-6">
          {signedIn === false ? (
            <>
              <h1 className="m-0 text-[28px] leading-[1.2] font-bold tracking-[-0.02em]">
                Sign in to review your agent&apos;s request
              </h1>
              <ApproveSignIn base={path} onSignedIn={(id) => void signedInHere(id)} />
            </>
          ) : !action ? (
            <span className="text-base text-[var(--slate-600)]">{error ? '' : 'Loading…'}</span>
          ) : (
            <>
              <div className="flex flex-col gap-3">
                <span className="text-sm text-[var(--slate-500)]">
                  {action.appName} asks you to approve
                </span>
                <h1 className="m-0 text-[28px] leading-[1.2] font-bold tracking-[-0.02em]">
                  {action.title}
                </h1>
              </div>
              {action.details.length > 0 && (
                <div className="bg-white border border-[var(--slate-200)] rounded-2xl px-4 py-1">
                  {action.details.map((d) => (
                    <div
                      key={d.label}
                      className="flex justify-between gap-4 py-3.5 text-[15px] border-b last:border-b-0 border-[var(--slate-100)]"
                    >
                      <span className="text-[var(--slate-500)]">{d.label}</span>
                      <span className="font-medium text-right break-all">{d.value}</span>
                    </div>
                  ))}
                </div>
              )}
              {action.status === 'pending' && action.ownerSignIn && !c ? (
                <div className="flex flex-col gap-3">
                  <span className="text-[15px] text-[var(--slate-600)] leading-snug">
                    This runs from your wallet. Sign in again to approve it.
                  </span>
                  <ApproveSignIn base={path} onSignedIn={(id) => setC(id)} />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void decide(false)}
                    className="btn btn-secondary btn-lg h-12 bg-white"
                  >
                    Decline
                  </button>
                </div>
              ) : action.status === 'pending' ? (
                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void decide(false)}
                    className="btn btn-secondary btn-lg h-12 bg-white"
                  >
                    Decline
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void decide(true)}
                    className="btn btn-primary btn-lg h-12"
                  >
                    {busy ? 'Approving…' : 'Approve'}
                  </button>
                </div>
              ) : action.status === 'running' ? (
                <span className="text-base text-[var(--slate-600)]">Working on it…</span>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <span className="text-base font-medium">{DONE[action.status]}</span>
                  {action.status === 'failed' && action.error && (
                    <span className="text-sm text-[var(--slate-600)]">{action.error.error}</span>
                  )}
                  {action.status !== 'expired' && (
                    <span className="text-sm text-[var(--slate-500)]">
                      You can close this tab and go back to {action.appName}.
                    </span>
                  )}
                </div>
              )}
            </>
          )}
          {error && <span className="text-sm text-[var(--red-700)] font-medium">{error}</span>}
        </div>
      </div>
    </div>
  );
}

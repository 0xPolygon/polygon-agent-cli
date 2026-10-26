import { useEffect, useState } from 'react';

import { LogoBadge } from '../App.js';
import { RETURN_KEY, SignIn } from './Onboarding.js';
import { currentSession } from './signin.js';

interface Action {
  actionId: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'declined' | 'expired';
  title: string;
  details: { label: string; value: string }[];
  appName: string;
  expiresAt: string;
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
export function Approve() {
  const params = new URLSearchParams(window.location.search);
  const path = `/api/actions/${encodeURIComponent(params.get('k') ?? '')}/${encodeURIComponent(params.get('a') ?? '')}`;
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
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
    void currentSession().then(async (s) => {
      setSignedIn(!!s);
      if (!s) {
        try {
          sessionStorage.setItem(RETURN_KEY, window.location.pathname + window.location.search);
        } catch {
          // a Google sign-in then lands on the dashboard instead
        }
        return;
      }
      await load().catch((e: Error) => setError(e.message));
    });
    // Runs once, on load.
  }, []);

  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve })
      });
      const data = (await res.json().catch(() => ({}))) as Action & { message?: string };
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
            <SignIn finishing={false} onSignedIn={() => window.location.reload()} />
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
              {action.status === 'pending' ? (
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

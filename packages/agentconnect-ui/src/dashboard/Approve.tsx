import { useEffect, useState } from 'react';

import { LogoBadge } from '../App.js';
import { usd } from './ui.js';

// Set while a Google sign-in for an approval is out at the relay; the relay
// returns to the static `/login`, which reads this to pick up where it left off.
export const APPROVE_KEY = 'agentconnect_approve';

export function isApproveReturn(): boolean {
  try {
    return !!sessionStorage.getItem(APPROVE_KEY);
  } catch {
    return false;
  }
}

interface Purchase {
  merchant: string;
  merchantUrl: string | null;
  totalCents: number;
  items: { name: string; qty: number; priceCents?: number }[];
  status: string;
  c: string | null;
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

const DONE: Record<string, string> = {
  approved: 'Approved. Your agent is paying with a one-time card for this total.',
  placed: 'Approved. The order is placed.',
  placing: 'Approved. Your order is being placed.',
  awaiting_passkey: 'Approved. Confirm with your passkey to pay.',
  declined: 'Declined. Nothing was charged.',
  failed: "The purchase didn't go through, and nothing was charged.",
  canceled: 'Canceled. Nothing was charged.'
};

/**
 * An agent wants to pay more than the owner's auto-pay limit. The owner signs
 * in, then approves or declines; the agent sees the answer on its next check.
 */
export function Approve({ finishing = false }: { finishing?: boolean }) {
  const [saved] = useState<{ r: string; c: string } | null>(() => {
    try {
      const raw = sessionStorage.getItem(APPROVE_KEY);
      return finishing && raw ? (JSON.parse(raw) as { r: string; c: string }) : null;
    } catch {
      return null;
    }
  });
  const [r] = useState(
    () => saved?.r ?? new URLSearchParams(window.location.search).get('r') ?? ''
  );
  const [c, setC] = useState<string | null>(saved?.c ?? null);
  const [purchase, setPurchase] = useState<Purchase | null>(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code' | 'decide' | 'done'>('email');
  const [done, setDone] = useState<string | null>(null);
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
    void fetch(`/api/approve?r=${encodeURIComponent(r)}`)
      .then(async (res) => {
        const d = (await res.json()) as Purchase & { message?: string };
        if (!res.ok) throw new Error(d.message ?? 'This approval link is not valid.');
        setPurchase(d);
        if (d.status !== 'pending') {
          setDone(DONE[d.status] ?? 'This purchase was already decided.');
          setStep('done');
        } else if (!saved) {
          setC(d.c);
        }
      })
      .catch((e: Error) => setError(e.message));
    if (finishing && saved) {
      void run(async () => {
        sessionStorage.removeItem(APPROVE_KEY);
        await post('/api/approve/google/finish', {
          c: saved.c,
          callbackUrl: window.location.href
        });
        window.history.replaceState(null, '', `/approve?r=${saved.r}`);
        setStep('decide');
      });
    }
    // Runs once, on load.
  }, []);

  const decide = (approve: boolean) =>
    run(async () => {
      const res = await post<{ status: string; passkeyUrl?: string | null }>(
        '/api/approve/decide',
        { c, approve }
      );
      if (res.passkeyUrl) {
        window.location.assign(res.passkeyUrl);
        return;
      }
      setDone(DONE[res.status] ?? 'Done.');
      setStep('done');
    });

  return (
    <div className="min-h-[100dvh] flex flex-col bg-[var(--slate-50)] text-[var(--slate-900)]">
      <div className="h-16 flex items-center px-6 bg-white border-b border-[var(--slate-200)]">
        <LogoBadge />
      </div>
      <div className="flex-1 flex items-center justify-center px-5 py-10">
        <div className="w-full max-w-[420px] flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <span className="text-sm text-[var(--slate-500)]">Your agent wants to pay</span>
            <h1 className="m-0 text-[40px] leading-none font-bold tracking-[-0.02em]">
              {purchase ? usd(purchase.totalCents / 100) : '…'}
            </h1>
            <span className="text-base text-[var(--slate-600)]">
              {purchase ? `at ${purchase.merchant}` : ''}
            </span>
          </div>

          {purchase && purchase.items.length > 0 && (
            <div className="bg-white border border-[var(--slate-200)] rounded-2xl px-4 py-1">
              {purchase.items.map((i) => (
                <div
                  key={i.name}
                  className="flex justify-between gap-3 py-3 text-[15px] border-b last:border-b-0 border-[var(--slate-100)]"
                >
                  <span className="min-w-0">
                    {i.qty > 1 ? `${i.qty} × ` : ''}
                    {i.name}
                  </span>
                  {i.priceCents !== undefined && (
                    <span className="font-bold flex-shrink-0">{usd(i.priceCents / 100)}</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {step === 'done' ? (
            <span className="text-base font-medium">{done}</span>
          ) : step === 'decide' ? (
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
          ) : busy && finishing ? (
            <span className="text-base text-[var(--slate-600)]">Signing you in…</span>
          ) : step === 'email' ? (
            <>
              <form
                className="flex flex-col gap-2.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await post('/api/approve/email/start', { c, email: email.trim() });
                    setStep('code');
                  });
                }}
              >
                <label htmlFor="email" className="text-sm font-medium text-[var(--slate-600)]">
                  Sign in to approve
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
                <button
                  type="submit"
                  disabled={busy || !c}
                  className="btn btn-primary btn-lg w-full h-12"
                >
                  {busy ? 'Sending code…' : 'Continue with email'}
                </button>
              </form>
              <button
                type="button"
                disabled={busy || !c}
                onClick={() =>
                  void run(async () => {
                    const { url } = await post<{ url: string }>('/api/approve/google/start', { c });
                    sessionStorage.setItem(APPROVE_KEY, JSON.stringify({ r, c }));
                    window.location.assign(url);
                  })
                }
                className="btn btn-secondary btn-lg w-full h-12 bg-white"
              >
                Continue with Google
              </button>
            </>
          ) : (
            <form
              className="flex flex-col gap-2.5"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await post('/api/approve/email/finish', { c, code: code.trim() });
                  setStep('decide');
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
      </div>
    </div>
  );
}

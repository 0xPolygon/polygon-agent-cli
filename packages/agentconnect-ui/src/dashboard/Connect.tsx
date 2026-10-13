import { useEffect, useState } from 'react';

import { LogoBadge } from '../App.js';

// Set while a Google sign-in for connecting an agent is out at the relay. The
// relay returns to the static `/login`; this tells that page whose return it is.
export const CONNECT_KEY = 'agentconnect_mcp_connect';

export function isConnectReturn(): boolean {
  try {
    return !!sessionStorage.getItem(CONNECT_KEY);
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

/**
 * An agent (an MCP client) asked for access to the agent wallet. The owner
 * signs in here; the worker issues the grant and sends them back to the agent.
 */
export function Connect({ finishing = false }: { finishing?: boolean }) {
  const [id] = useState(() => {
    if (!finishing) return new URLSearchParams(window.location.search).get('c') ?? '';
    try {
      return sessionStorage.getItem(CONNECT_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [client, setClient] = useState<string | null>(null);
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
      setBusy(false);
    }
  };
  const done = ({ redirectTo }: { redirectTo: string }) => {
    try {
      sessionStorage.removeItem(CONNECT_KEY);
    } catch {
      // nothing to clean up
    }
    window.location.assign(redirectTo);
  };

  useEffect(() => {
    void fetch(`/api/connect?c=${encodeURIComponent(id)}`)
      .then(async (r) => {
        const d = (await r.json()) as { clientName?: string; message?: string };
        if (!r.ok) throw new Error(d.message ?? 'This connect link expired.');
        setClient(d.clientName ?? 'Your agent');
      })
      .catch((e: Error) => setError(e.message));
    if (finishing) {
      void run(async () =>
        done(
          await post<{ redirectTo: string }>('/api/connect/google/finish', {
            c: id,
            callbackUrl: window.location.href
          })
        )
      );
    }
    // Runs once, on load.
  }, []);

  return (
    <div className="min-h-[100dvh] flex flex-col bg-[var(--slate-50)] text-[var(--slate-900)]">
      <div className="h-16 flex items-center px-6 bg-white border-b border-[var(--slate-200)]">
        <LogoBadge />
      </div>
      <div className="flex-1 flex items-center justify-center px-5 py-10">
        <div className="w-full max-w-[420px] flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <h1 className="m-0 text-[30px] leading-[1.15] font-bold tracking-[-0.02em]">
              Connect {client ?? 'your agent'} to your wallet
            </h1>
            <p className="m-0 text-base leading-snug text-[var(--slate-600)]">
              It can see your balance and buy for you with your saved card. You approve every
              purchase.
            </p>
          </div>

          {busy && finishing ? (
            <span className="text-base text-[var(--slate-600)]">Signing you in…</span>
          ) : !sent ? (
            <form
              className="flex flex-col gap-2.5"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await post('/api/connect/email/start', { c: id, email: email.trim() });
                  setSent(true);
                  setBusy(false);
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
                void run(async () =>
                  done(
                    await post<{ redirectTo: string }>('/api/connect/email/finish', {
                      c: id,
                      code: code.trim()
                    })
                  )
                );
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
                {busy ? 'Connecting…' : 'Connect'}
              </button>
            </form>
          )}

          {!sent && !(busy && finishing) && (
            <>
              <div className="flex items-center gap-3 text-[13px] text-[var(--slate-400)]">
                <div className="flex-1 h-px bg-[var(--slate-200)]" />
                or
                <div className="flex-1 h-px bg-[var(--slate-200)]" />
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const { url } = await post<{ url: string }>('/api/connect/google/start', {
                      c: id
                    });
                    sessionStorage.setItem(CONNECT_KEY, id);
                    window.location.assign(url);
                  })
                }
                className="btn btn-secondary btn-lg w-full h-12 bg-white"
              >
                Continue with Google
              </button>
            </>
          )}

          {error && <span className="text-sm text-[var(--red-700)] font-medium">{error}</span>}
        </div>
      </div>
    </div>
  );
}

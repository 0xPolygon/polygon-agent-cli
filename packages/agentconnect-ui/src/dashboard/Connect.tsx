import { ArrowLeftRight, Ban, Eye, MapPin, Send, ShoppingBag } from 'lucide-react';
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

interface Spending {
  defaultUsd: number;
  defaultDays: number;
  minUsd: number;
  maxUsd: number;
  maxDays: number;
}

interface Consent {
  email: string | null;
  autoPayLimitCents: number | null;
  // This agent can buy with the saved address and cards.
  shops: boolean;
  // This agent asks the user to approve every purchase before paying.
  confirmsEachPurchase: boolean;
  // Every purchase waits for the owner's approval here, whatever the limit.
  approvesEachPurchase: boolean;
  // The agent runs on this machine; once allowed, the dashboard opens in front.
  localAgent: boolean;
  // Set when the agent may move money: the allowance the owner approves.
  spending?: Spending;
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

// Buying with the owner's saved address and cards, in the owner's words.
function shopping(c: Consent) {
  const limitCents = c.autoPayLimitCents;
  return [
    { icon: MapPin, text: 'Use your saved address and cards at checkout' },
    {
      icon: ShoppingBag,
      text: c.approvesEachPurchase
        ? 'Buy for you at any online store. You approve every purchase'
        : c.confirmsEachPurchase
          ? limitCents === null || limitCents === 0
            ? 'Buy for you once you approve the total. You also approve every purchase here'
            : `Buy for you once you approve the total. Over ${dollars(limitCents)}, you also approve here`
          : limitCents === null
            ? 'Buy for you. Bigger purchases wait for your approval'
            : limitCents === 0
              ? 'Buy for you. Every purchase waits for your approval'
              : `Buy for you up to ${dollars(limitCents)} on its own. Anything more waits for your approval`
    }
  ];
}

const usd = (n: number) => `$${n.toLocaleString('en-US')}`;

function spendingPermissions(allowanceUsd: number, days: number) {
  const period = days === 1 ? 'a day' : `${days} days`;
  return [
    { icon: Send, text: `Send and pay up to ${usd(allowanceUsd)} over ${period}` },
    { icon: ArrowLeftRight, text: 'Swap and bridge tokens within that limit' }
  ];
}

const AMOUNTS = [100, 500, 1000, 5000];
const PERIODS = [7, 30];

/**
 * An agent (an MCP client) asked for access to the agent wallet. The owner
 * signs in here (or already is), reviews what the agent may do, and allows or
 * denies; either way the page goes back to the agent.
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
  const [consent, setConsent] = useState<Consent | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(finishing);
  const [error, setError] = useState<string | null>(null);
  // Before sign-in: whether the agent will ask for an allowance.
  const [asksToSpend, setAsksToSpend] = useState(false);
  const [allowanceUsd, setAllowanceUsd] = useState(1000);
  const [days, setDays] = useState(30);

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
  const forgetReturn = () => {
    try {
      sessionStorage.removeItem(CONNECT_KEY);
    } catch {
      // nothing to clean up
    }
  };

  useEffect(() => {
    if (finishing) {
      void run(async () => {
        forgetReturn();
        const c = await post<Consent>('/api/connect/google/finish', {
          c: id,
          callbackUrl: window.location.href
        });
        window.history.replaceState(null, '', `/connect?c=${id}`);
        setConsent(c);
      });
    }
    void fetch(`/api/connect?c=${encodeURIComponent(id)}`)
      .then(async (r) => {
        const d = (await r.json()) as Omit<Partial<Consent>, 'spending'> & {
          clientName?: string;
          signedIn?: boolean;
          message?: string;
          spending?: Spending | true;
        };
        if (!r.ok) throw new Error(d.message ?? 'This connect link expired.');
        setClient(d.clientName ?? 'Your agent');
        if (d.spending) setAsksToSpend(true);
        if (d.signedIn) {
          setConsent({
            email: d.email ?? null,
            autoPayLimitCents: d.autoPayLimitCents ?? null,
            shops: d.shops === true,
            confirmsEachPurchase: d.confirmsEachPurchase === true,
            approvesEachPurchase: d.approvesEachPurchase === true,
            localAgent: d.localAgent === true,
            ...(d.spending && d.spending !== true ? { spending: d.spending } : {})
          });
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoaded(true));
    // Runs once, on load.
  }, []);

  const decide = (allow: boolean) => {
    // A local agent's own page only says it's done, so the dashboard comes
    // next. A new tab has to open now, while the click still allows one.
    const local = allow && consent?.localAgent === true;
    const home = local ? window.open('', '_blank') : null;
    return run(async () => {
      try {
        const { redirectTo } = await post<{ redirectTo: string }>('/api/connect/decide', {
          c: id,
          allow,
          ...(allow && consent?.spending ? { allowanceUsd, days } : {})
        });
        if (!local || redirectTo.startsWith('http')) {
          // This tab hands the agent its sign-in, behind the dashboard.
          home?.location.assign('/');
          window.location.assign(redirectTo);
          return;
        }
        // An app link opens the agent and leaves this page here: go home.
        home?.close();
        window.location.assign(redirectTo);
        setTimeout(() => window.location.assign('/'), 1500);
      } catch (e) {
        home?.close();
        throw e;
      }
    });
  };

  const name = client ?? 'Your agent';
  const spending = consent?.spending;
  const permissions = [
    { icon: Eye, text: 'See your balance and what you hold' },
    ...(spending ? spendingPermissions(allowanceUsd, days) : []),
    ...(consent?.shops ? shopping(consent) : []),
    ...(spending ? [] : [{ icon: Ban, text: "It can't send or withdraw your money" }])
  ];
  const amountValid =
    !spending ||
    (Number.isFinite(allowanceUsd) &&
      allowanceUsd >= spending.minUsd &&
      allowanceUsd <= spending.maxUsd);

  // Once the consent screen knows the limits, start from its defaults.
  useEffect(() => {
    if (!spending) return;
    setAllowanceUsd(spending.defaultUsd);
    setDays(spending.defaultDays);
  }, [spending?.defaultUsd, spending?.defaultDays]);

  return (
    <div className="min-h-[100dvh] flex flex-col bg-[var(--slate-50)] text-[var(--slate-900)]">
      <div className="h-16 flex items-center px-6 bg-white border-b border-[var(--slate-200)]">
        <LogoBadge />
      </div>
      <div className="flex-1 flex items-center justify-center px-5 py-10">
        <div className="w-full max-w-[420px] flex flex-col gap-6">
          {consent ? (
            <>
              <div className="flex flex-col gap-3">
                <h1 className="m-0 text-[30px] leading-[1.15] font-bold tracking-[-0.02em]">
                  Allow {name} to use your wallet?
                </h1>
                {consent.email && (
                  <p className="m-0 text-base text-[var(--slate-600)]">
                    Signed in as {consent.email}
                  </p>
                )}
              </div>
              <div className="bg-white border border-[var(--slate-200)] rounded-2xl px-4 py-1">
                {permissions.map((p) => (
                  <div
                    key={p.text}
                    className="flex items-center gap-3 py-3.5 text-[15px] border-b last:border-b-0 border-[var(--slate-100)]"
                  >
                    <p.icon className="w-[18px] h-[18px] flex-shrink-0 text-[var(--slate-500)]" />
                    <span>{p.text}</span>
                  </div>
                ))}
              </div>
              {spending && (
                <div className="flex flex-col gap-3">
                  <span className="text-sm font-medium text-[var(--slate-600)]">
                    Spending limit
                  </span>
                  <div className="grid grid-cols-4 gap-2">
                    {AMOUNTS.map((a) => (
                      <button
                        key={a}
                        type="button"
                        disabled={busy}
                        onClick={() => setAllowanceUsd(a)}
                        aria-pressed={allowanceUsd === a}
                        className={`h-10 rounded-xl border text-sm font-medium ${
                          allowanceUsd === a
                            ? 'border-[var(--purple-500)] bg-[var(--purple-50)] text-[var(--purple-700)]'
                            : 'border-[var(--slate-300)] bg-white'
                        }`}
                      >
                        {usd(a)}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2.5">
                    <label htmlFor="allowance" className="sr-only">
                      Other amount in US dollars
                    </label>
                    <input
                      id="allowance"
                      inputMode="numeric"
                      value={String(allowanceUsd)}
                      onChange={(e) =>
                        setAllowanceUsd(Number(e.target.value.replace(/[^0-9]/g, '')))
                      }
                      className={`${inputClass} h-10 flex-1`}
                    />
                    <label htmlFor="days" className="sr-only">
                      Period
                    </label>
                    <select
                      id="days"
                      value={days}
                      disabled={busy}
                      onChange={(e) => setDays(Number(e.target.value))}
                      className={`${inputClass} h-10`}
                    >
                      {PERIODS.filter((d) => d <= spending.maxDays).map((d) => (
                        <option key={d} value={d}>
                          over {d} days
                        </option>
                      ))}
                    </select>
                  </div>
                  {!amountValid && (
                    <span className="text-sm text-[var(--red-700)]">
                      Choose between {usd(spending.minUsd)} and {usd(spending.maxUsd)}.
                    </span>
                  )}
                </div>
              )}
              <span className="text-[13px] text-[var(--slate-500)] leading-snug">
                {spending
                  ? `${name} spends from your agent wallet, never past this limit. Disconnect it anytime in Settings to stop it.`
                  : consent.shops && !consent.approvesEachPurchase
                    ? `Change your auto-pay limit or disconnect ${name} anytime in Settings.`
                    : `Disconnect ${name} anytime in Settings.`}
              </span>
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decide(false)}
                  className="btn btn-secondary btn-lg h-12 bg-white"
                >
                  Don&apos;t allow
                </button>
                <button
                  type="button"
                  disabled={busy || !amountValid}
                  onClick={() => void decide(true)}
                  className="btn btn-primary btn-lg h-12"
                >
                  {busy ? (spending ? 'Approving…' : 'Connecting…') : 'Allow'}
                </button>
              </div>
            </>
          ) : (busy && finishing) || !loaded ? (
            <span className="text-base text-[var(--slate-600)]">
              {finishing ? 'Signing you in…' : 'Loading…'}
            </span>
          ) : (
            <>
              <div className="flex flex-col gap-3">
                <h1 className="m-0 text-[30px] leading-[1.15] font-bold tracking-[-0.02em]">
                  Connect {name} to your wallet
                </h1>
                <p className="m-0 text-base leading-snug text-[var(--slate-600)]">
                  {asksToSpend
                    ? 'Sign in, then choose how much it can spend.'
                    : 'Sign in, then choose what it can do.'}
                </p>
              </div>

              {!sent ? (
                <form
                  className="flex flex-col gap-2.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(async () => {
                      await post('/api/connect/email/start', { c: id, email: email.trim() });
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
                  <button
                    type="submit"
                    disabled={busy}
                    className="btn btn-primary btn-lg w-full h-12"
                  >
                    {busy ? 'Sending code…' : 'Continue with email'}
                  </button>
                </form>
              ) : (
                <form
                  className="flex flex-col gap-2.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(async () =>
                      setConsent(
                        await post<Consent>('/api/connect/email/finish', {
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
                  <button
                    type="submit"
                    disabled={busy}
                    className="btn btn-primary btn-lg w-full h-12"
                  >
                    {busy ? 'Signing in…' : 'Continue'}
                  </button>
                </form>
              )}

              {!sent && (
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
            </>
          )}

          {error && <span className="text-sm text-[var(--red-700)] font-medium">{error}</span>}
        </div>
      </div>
    </div>
  );
}

import { ArrowLeftRight, Ban, Eye, Send } from 'lucide-react';
import { useEffect, useState } from 'react';

import { LoginShell } from '../login/LoginShell.js';
import { ConnectConsent } from './connect/ConnectConsent.js';
import { ConnectLoading } from './connect/ConnectLoading.js';
import { ConnectSignIn } from './connect/ConnectSignIn.js';
import { ErrorNote } from './connect/ErrorNote.js';
import { usd } from './connect/usd.js';

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

interface Spending {
  defaultUsd: number;
  defaultDays: number;
  minUsd: number;
  maxUsd: number;
  maxDays: number;
}

interface Consent {
  email: string | null;
  // The agent runs on this machine; once allowed, the dashboard opens in front.
  localAgent: boolean;
  // Set when the agent may move money: the allowance the owner approves.
  spending?: Spending;
}

// What the agent gets, in the owner's words.
const READ_ONLY = [
  { icon: Eye, text: 'See your balance and what you hold' },
  { icon: Ban, text: "It can't send or withdraw your money" }
];

function spendingPermissions(allowanceUsd: number, days: number) {
  const period = days === 1 ? 'a day' : `${days} days`;
  return [
    { icon: Eye, text: 'See your balance and what you hold' },
    { icon: Send, text: `Send and pay up to ${usd(allowanceUsd)} over ${period}` },
    { icon: ArrowLeftRight, text: 'Swap and bridge tokens within that limit' }
  ];
}

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
  const midName = name === 'Your agent' ? 'your agent' : name;
  const spending = consent?.spending;
  const permissions = spending ? spendingPermissions(allowanceUsd, days) : READ_ONLY;
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
    <LoginShell>
      {consent ? (
        <ConnectConsent
          name={name}
          midName={midName}
          email={consent.email}
          permissions={permissions}
          spending={spending}
          allowanceUsd={allowanceUsd}
          days={days}
          busy={busy}
          amountValid={amountValid}
          setAllowanceUsd={setAllowanceUsd}
          setDays={setDays}
          onDecide={(allow) => void decide(allow)}
        />
      ) : (busy && finishing) || !loaded ? (
        <ConnectLoading finishing={finishing} />
      ) : (
        <ConnectSignIn
          midName={midName}
          asksToSpend={asksToSpend}
          sent={sent}
          email={email}
          code={code}
          busy={busy}
          setEmail={setEmail}
          setCode={setCode}
          onEmailSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await post('/api/connect/email/start', { c: id, email: email.trim() });
              setSent(true);
            });
          }}
          onCodeSubmit={(e) => {
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
          onGoogle={() =>
            void run(async () => {
              const { url } = await post<{ url: string }>('/api/connect/google/start', {
                c: id
              });
              sessionStorage.setItem(CONNECT_KEY, id);
              window.location.assign(url);
            })
          }
        />
      )}

      {error && <ErrorNote>{error}</ErrorNote>}
    </LoginShell>
  );
}

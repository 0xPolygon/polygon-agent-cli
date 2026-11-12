import { useEffect, useState } from 'react';

import { LoginHeading } from '../login/LoginHeading.js';
import { LoginShell } from '../login/LoginShell.js';
import { ApproveActions } from './approve/ApproveActions.js';
import { ApproveCodeForm } from './approve/ApproveCodeForm.js';
import { ApproveEmailForm } from './approve/ApproveEmailForm.js';
import { ApproveLoading } from './approve/ApproveLoading.js';
import { ApproveRequest } from './approve/ApproveRequest.js';
import { ApproveResign } from './approve/ApproveResign.js';
import { ApproveResult } from './approve/ApproveResult.js';
import { ApproveRunning } from './approve/ApproveRunning.js';
import { ErrorNote } from './connect/ErrorNote.js';
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
        <ApproveEmailForm
          email={email}
          busy={busy}
          setEmail={setEmail}
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              setC(
                (await post<{ c: string }>(`${base}/signin/email/start`, { email: email.trim() })).c
              );
            });
          }}
          onGoogle={() =>
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
        />
      ) : (
        <ApproveCodeForm
          email={email}
          code={code}
          busy={busy}
          setCode={setCode}
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await post(`${base}/signin/email/finish`, { c, code: code.trim() });
              onSignedIn(c);
            });
          }}
        />
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

export interface Action {
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

/**
 * An agent's request to spend, from an app that has the owner approve each one
 * (ChatGPT). The owner, signed in on this site, sees what it does and approves
 * or declines it. Approving answers at once: it runs in the background, and the
 * agent, waiting on it, carries on with the result. The page follows along.
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

  // Follows a running action to its result.
  useEffect(() => {
    if (action?.status !== 'running') return;
    const timer = setTimeout(() => void load().catch(() => {}), 2000);
    return () => clearTimeout(timer);
  }, [action]);

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
      if (!res.ok) throw new Error(data.message ?? 'Something went wrong. Try again.');
      setAction(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <LoginShell>
      {signedIn === false ? (
        <>
          <LoginHeading title="Sign in to review your agent's request" />
          <ApproveSignIn base={path} onSignedIn={(id) => void signedInHere(id)} />
        </>
      ) : !action ? (
        <ApproveLoading error={error} />
      ) : (
        <>
          <ApproveRequest action={action} />
          {action.status === 'pending' && action.ownerSignIn && !c ? (
            <ApproveResign busy={busy} onDecline={() => void decide(false)}>
              <ApproveSignIn base={path} onSignedIn={(id) => setC(id)} />
            </ApproveResign>
          ) : action.status === 'pending' ? (
            <ApproveActions busy={busy} onDecide={(approve) => void decide(approve)} />
          ) : action.status === 'running' ? (
            <ApproveRunning appName={action.appName} />
          ) : (
            <ApproveResult
              status={action.status}
              appName={action.appName}
              failure={action.status === 'failed' ? action.error?.error : undefined}
            />
          )}
        </>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </LoginShell>
  );
}

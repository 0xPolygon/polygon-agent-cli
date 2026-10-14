// Signing in on the site. The worker does the OMS sign-in (the OMS project only
// accepts browser calls from the production origin, so this works on any
// domain) and answers with an HttpOnly session cookie for the agent wallet.

import { rememberEmail } from './account.js';

// Set while a Google sign-in started here is out at the relay. The relay
// returns to the static `/login` (its allowlist is an exact match), and this
// tells that page the return belongs to the site's sign-in, not to a CLI. It
// holds the worker's sign-in id.
export const WEB_SIGNIN_KEY = 'agentconnect_web_signin';

export interface Session {
  wallet: string;
  email: string | null;
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

function signedIn(s: Session): string {
  rememberEmail(s.wallet, s.email);
  return s.wallet;
}

/** Who is signed in on this browser, if anyone. */
export async function currentSession(): Promise<Session | null> {
  const res = await fetch('/api/session').catch(() => null);
  if (!res?.ok) return null;
  const s = (await res.json()) as Session;
  rememberEmail(s.wallet, s.email);
  return s;
}

export async function signOut(): Promise<void> {
  await fetch('/api/session', { method: 'DELETE' }).catch(() => {});
}

let pending: string | null = null;

export async function startEmail(email: string): Promise<void> {
  pending = (await post<{ c: string }>('/api/session/email/start', { email })).c;
}

export async function finishEmail(code: string): Promise<string> {
  return signedIn(await post<Session>('/api/session/email/finish', { c: pending, code }));
}

/** Sends the browser to Google; it comes back to `/login`. */
export async function startGoogle(): Promise<void> {
  const { c, url } = await post<{ c: string; url: string }>('/api/session/google/start', {});
  sessionStorage.setItem(WEB_SIGNIN_KEY, c);
  window.location.assign(url);
}

/** True when this `/login` load is a Google return for a sign-in started here. */
export function isWebSigninReturn(): boolean {
  try {
    return !!sessionStorage.getItem(WEB_SIGNIN_KEY);
  } catch {
    return false;
  }
}

export async function finishGoogle(): Promise<string> {
  const c = sessionStorage.getItem(WEB_SIGNIN_KEY);
  sessionStorage.removeItem(WEB_SIGNIN_KEY);
  const wallet = signedIn(
    await post<Session>('/api/session/google/finish', { c, callbackUrl: window.location.href })
  );
  window.history.replaceState(null, '', '/');
  return wallet;
}

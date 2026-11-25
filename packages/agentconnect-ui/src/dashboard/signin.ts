// Signing in on the site. The worker does the OMS sign-in (the OMS project only
// accepts browser calls from the production origin, so this works on any
// domain) and answers with an HttpOnly session cookie for the agent wallet.

import { z } from 'zod/v4';

import { rememberEmail } from './account.js';
import { post } from './api.js';

// Set while a Google sign-in started here is out at the relay. The relay
// returns to the static `/login` (its allowlist is an exact match), and this
// tells that page the return belongs to the site's sign-in, not to a CLI. It
// holds the worker's sign-in id.
export const WEB_SIGNIN_KEY = 'agentconnect_web_signin';

const SessionSchema = z.looseObject({
  wallet: z.string(),
  email: z
    .string()
    .nullish()
    .transform((e) => e ?? null)
});
export type Session = z.infer<typeof SessionSchema>;

function signedIn(s: Session): string {
  rememberEmail(s.wallet, s.email);
  return s.wallet;
}

/** Who is signed in on this browser, if anyone. */
export async function currentSession(): Promise<Session | null> {
  const res = await fetch('/api/session').catch(() => null);
  if (!res?.ok) return null;
  const s = SessionSchema.safeParse(await res.json().catch(() => null)).data;
  if (!s) return null;
  rememberEmail(s.wallet, s.email);
  return s;
}

export async function signOut(): Promise<void> {
  await fetch('/api/session', { method: 'DELETE' }).catch(() => {});
}

let pending: string | null = null;

export async function startEmail(email: string): Promise<void> {
  pending = (await post('/api/session/email/start', { email }, z.looseObject({ c: z.string() }))).c;
}

export async function finishEmail(code: string): Promise<string> {
  return signedIn(await post('/api/session/email/finish', { c: pending, code }, SessionSchema));
}

/** Sends the browser to Google; it comes back to `/login`. */
export async function startGoogle(): Promise<void> {
  const { c, url } = await post(
    '/api/session/google/start',
    {},
    z.looseObject({ c: z.string(), url: z.string() })
  );
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
    await post(
      '/api/session/google/finish',
      { c, callbackUrl: window.location.href },
      SessionSchema
    )
  );
  window.history.replaceState(null, '', '/');
  return wallet;
}

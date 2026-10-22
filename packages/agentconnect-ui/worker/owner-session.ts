// The owner's sign-in on the site itself: after an email code or Google
// sign-in (done by the worker, see owner-signin.ts), the browser holds an
// HttpOnly cookie naming the agent wallet. The dashboard's saved-details calls
// accept it in place of an agent's link token, so the site works without one.

import type { AgentIdentity } from './agent-auth.ts';
import type { SignedIn } from './owner-signin.ts';

import { AuthError, decodeJson, encodeJson, hmac, safeEqual } from './agent-auth.ts';

export const SESSION_COOKIE = 'agentconnect_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

interface SessionClaims {
  w: string;
  e: string | null;
  iat: number;
  exp: number;
}

export async function issueSession(
  who: SignedIn,
  secret: string,
  now = Math.floor(Date.now() / 1000)
): Promise<string> {
  const claims: SessionClaims = {
    w: who.wallet.toLowerCase(),
    e: who.email,
    iat: now,
    exp: now + SESSION_TTL_SECONDS
  };
  const payload = encodeJson(claims);
  return `os1.${payload}.${await hmac(secret, `os1.${payload}`)}`;
}

export async function verifySession(
  token: string,
  secret: string,
  now = Math.floor(Date.now() / 1000)
): Promise<SignedIn> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'os1') throw new AuthError('malformed', 'Sign in again');
  if (!safeEqual(await hmac(secret, `os1.${parts[1]}`), parts[2])) {
    throw new AuthError('bad_signature', 'Sign in again');
  }
  const claims = decodeJson<SessionClaims>(parts[1]);
  if (typeof claims.exp !== 'number' || claims.exp < now) {
    throw new AuthError('expired', 'Your sign-in expired. Sign in again.');
  }
  return { wallet: claims.w, email: claims.e };
}

export function readSessionCookie(req: Request): string | null {
  const cookies = req.headers.get('Cookie') ?? '';
  for (const part of cookies.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=') || null;
  }
  return null;
}

export function sessionCookie(req: Request, value: string | null): string {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  const life = value ? `Max-Age=${SESSION_TTL_SECONDS}` : 'Max-Age=0';
  return `${SESSION_COOKIE}=${value ?? ''}; Path=/; HttpOnly; SameSite=Lax; ${life}${secure}`;
}

/**
 * The owner behind this request's session cookie. Changes must come from this
 * site: SameSite=Lax already keeps the cookie off cross-site posts, and the
 * Origin check covers browsers that send it anyway.
 */
export async function sessionIdentity(req: Request, secret: string): Promise<AgentIdentity | null> {
  const token = readSessionCookie(req);
  if (!token) return null;
  if (req.method !== 'GET' && req.headers.get('Origin') !== new URL(req.url).origin) {
    throw new AuthError('bad_origin', 'Requests must come from this site');
  }
  const who = await verifySession(token, secret);
  return { wallet: who.wallet, agentKey: '', email: who.email };
}

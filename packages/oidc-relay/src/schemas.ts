// Shapes of what the relay accepts over HTTP, checked at the edge before a
// request reaches a session's Durable Object.

import { z } from 'zod';

import type { LoginAction } from './login-session.ts';

export const SESSION_ID = /^[A-Za-z0-9_-]{16,64}$/;
const SessionId = z.string().regex(SESSION_ID);

// Host allowlist for the oidc-callback URL. The callbackUrl is always our own
// agentconnect /login page (the omsRelayReturnUri) that the OMS relay returned
// the browser to, so only those hosts (plus localhost for dev) are accepted.
const ALLOWED_RETURN_HOSTS = new Set([
  'agentconnect.polygon.technology',
  'agentconnect.staging.polygon.technology',
  'localhost',
  '127.0.0.1'
]);

// Bound the callback URL the browser hands back after the OMS relay finishes the
// Google OAuth leg. It must be an https URL, or an http localhost/127.0.0.1 URL
// for local dev, on one of the allowlisted hosts, so a junk or spoofed value
// can't be smuggled through as an action.
export function validCallbackUrl(u: unknown): u is string {
  if (typeof u !== 'string' || u.length === 0 || u.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) return false;
  return ALLOWED_RETURN_HOSTS.has(url.hostname);
}

// Browser-submitted input. Only the known fields of each kind pass through.
export const LoginActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('google') }),
  z.object({ type: z.literal('cancel') }),
  z.object({
    type: z.literal('email'),
    email: z.string().min(3).max(320).includes('@')
  }),
  z.object({ type: z.literal('otp'), code: z.string().min(4).max(16) }),
  z.object({
    type: z.literal('oidc-callback'),
    callbackUrl: z.string().refine(validCallbackUrl)
  })
]) satisfies z.ZodType<LoginAction>;

// An invalid context is dropped by the session, never a 400, so it stays opaque here.
export const RegisterBody = z.object({ session: SessionId, context: z.unknown().optional() });
export const ActionBody = z.object({ session: SessionId, action: LoginActionSchema });
// The status is normalised by parseLoginStatus, which also drops a bad funding link instead of failing.
export const StatusBody = z.object({ session: SessionId, status: z.unknown() });

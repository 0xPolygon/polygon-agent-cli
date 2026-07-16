// Browser-login pairing relay (Cloudflare Worker + Durable Object).
//
// Purpose: let a CLI on ANY machine (including a remote server / openclaw) drive
// a browser-based login. The CLI arms a pairing session, the browser page polls
// for status and submits the chosen login method (Google, email, OTP), and the
// CLI polls for that input. The OMS relay now owns the Google OAuth callback
// itself; this relay only carries pairing state between the CLI and the page,
// including the `oidc-callback` action the page submits once the OMS relay
// returns the browser to it.
//
// Endpoints (all under /api/login):
//   POST /register  { session }                              (CLI: arm a pairing session)
//   POST /action  { session, action }                         (browser: submit user input)
//   GET  /next-action?session=  -> { state, action? }         (CLI: poll for input, one-time read)
//   POST /status  { session, ...LoginStatus }                 (CLI: publish state)
//   GET  /status?session=  -> LoginStatus                     (browser: poll state, repeat-readable)

import type { LoginAction } from './login-session.ts';

import { LoginSession, parseLoginStatus } from './login-session.ts';

export { LoginSession };

interface Env {
  LOGIN_SESSION: DurableObjectNamespace;
}

function cors(res: Response): Response {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(res.body, { status: res.status, headers: h });
}
function json(data: unknown, status = 200): Response {
  return cors(Response.json(data, { status }));
}

function validSession(s: string | null): s is string {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(s);
}

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

// Shape-check browser-submitted actions before they reach the DO.
export function validAction(a: unknown): a is LoginAction {
  if (typeof a !== 'object' || a === null) return false;
  const t = (a as { type?: unknown }).type;
  if (t === 'google' || t === 'cancel') return true;
  if (t === 'email') {
    const email = (a as { email?: unknown }).email;
    return (
      typeof email === 'string' && email.length >= 3 && email.length <= 320 && email.includes('@')
    );
  }
  if (t === 'otp') {
    const code = (a as { code?: unknown }).code;
    return typeof code === 'string' && code.length >= 4 && code.length <= 16;
  }
  if (t === 'oidc-callback') {
    return validCallbackUrl((a as { callbackUrl?: unknown }).callbackUrl);
  }
  return false;
}

// --- Worker entry / router ---
// Cloudflare Workers require a default export (the module's fetch handler), so
// the repo-wide "prefer named exports" rule doesn't apply to this entry point.
// eslint-disable-next-line import-x/no-default-export
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    // GET / or /health -> liveness check (confirm the worker is deployed/reachable).
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json({ ok: true, service: 'oidc-relay' });
    }

    // --- Browser-login pairing sessions (/api/login/*) ---
    const loginStub = (session: string) =>
      env.LOGIN_SESSION.get(env.LOGIN_SESSION.idFromName(session));

    // POST /api/login/register { session } -> arm a pairing session (CLI).
    if (request.method === 'POST' && url.pathname === '/api/login/register') {
      let body: { session?: unknown };
      try {
        body = (await request.json()) as { session?: unknown };
      } catch {
        return json({ error: 'invalid json' }, 400);
      }
      const session = typeof body.session === 'string' ? body.session : null;
      if (!validSession(session)) return json({ error: 'invalid session' }, 400);
      await loginStub(session).fetch(new Request('https://do/register', { method: 'POST' }));
      return cors(new Response(null, { status: 204 }));
    }

    // POST /api/login/action { session, action } -> browser submits user input.
    if (request.method === 'POST' && url.pathname === '/api/login/action') {
      let body: { session?: unknown; action?: unknown };
      try {
        body = (await request.json()) as { session?: unknown; action?: unknown };
      } catch {
        return json({ error: 'invalid json' }, 400);
      }
      const session = typeof body.session === 'string' ? body.session : null;
      if (!validSession(session) || !validAction(body.action)) {
        return json({ error: 'invalid request' }, 400);
      }
      const res = await loginStub(session).fetch(
        new Request('https://do/action', {
          method: 'POST',
          body: JSON.stringify(body.action)
        })
      );
      return cors(res);
    }

    // GET /api/login/next-action?session= -> CLI polls for user input (one-time read).
    if (request.method === 'GET' && url.pathname === '/api/login/next-action') {
      const session = url.searchParams.get('session');
      if (!validSession(session)) return json({ error: 'invalid session' }, 400);
      return cors(await loginStub(session).fetch(new Request('https://do/next-action')));
    }

    // POST /api/login/status { session, ...LoginStatus } -> CLI publishes state.
    if (request.method === 'POST' && url.pathname === '/api/login/status') {
      let body: { session?: unknown; status?: unknown };
      try {
        body = (await request.json()) as { session?: unknown; status?: unknown };
      } catch {
        return json({ error: 'invalid json' }, 400);
      }
      const session = typeof body.session === 'string' ? body.session : null;
      const parsed = parseLoginStatus(body.status);
      if (!validSession(session) || parsed === null) {
        return json({ error: 'invalid request' }, 400);
      }
      const res = await loginStub(session).fetch(
        new Request('https://do/set-status', {
          method: 'POST',
          body: JSON.stringify(parsed)
        })
      );
      return cors(res);
    }

    // GET /api/login/status?session= -> browser polls state (repeat-readable).
    if (request.method === 'GET' && url.pathname === '/api/login/status') {
      const session = url.searchParams.get('session');
      if (!validSession(session)) return json({ status: 'error', message: 'invalid session' }, 400);
      return cors(await loginStub(session).fetch(new Request('https://do/get-status')));
    }

    return new Response('not found', { status: 404 });
  }
};

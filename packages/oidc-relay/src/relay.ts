// Browser-login pairing relay (Cloudflare Worker + Durable Object).
//
// Purpose: let the CLI on ANY machine (including a remote server) complete a
// browser-based login. The CLI arms a pairing session under a random session id;
// the login page in the user's browser polls that session for status and submits
// the user's input (login method, email, OTP, or the OAuth return URL); the CLI
// polls for that input. The relay only carries pairing state between the two. It
// does not perform authentication itself.
//
// Each session is one Durable Object (see login-session.ts) that expires on its
// own after a fixed time. Endpoints:
//   GET  / or /health                                         (liveness check)
//   POST /api/login/register  { session, context? }           (CLI: arm a pairing session)
//   POST /api/login/action  { session, action }               (browser: submit user input)
//   GET  /api/login/next-action?session=  -> { state, action? }  (CLI: poll for input, one-time read)
//   POST /api/login/status  { session, status }               (CLI: publish state)
//   GET  /api/login/status?session=  -> LoginStatus           (browser: poll state, repeat-readable)

import { LoginSession, parseLoginStatus } from './login-session.ts';
import { ActionBody, RegisterBody, SESSION_ID, StatusBody } from './schemas.ts';

export { LoginSession };
export { validCallbackUrl } from './schemas.ts';

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
  return typeof s === 'string' && SESSION_ID.test(s);
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

    // POST /api/login/register { session, context? } -> arm a pairing session (CLI).
    // An invalid context is dropped by the session, never a 400.
    if (request.method === 'POST' && url.pathname === '/api/login/register') {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return json({ error: 'invalid json' }, 400);
      }
      const body = RegisterBody.safeParse(raw);
      if (!body.success) return json({ error: 'invalid session' }, 400);
      await loginStub(body.data.session).fetch(
        new Request('https://do/register', {
          method: 'POST',
          body: JSON.stringify(body.data.context ?? null)
        })
      );
      return cors(new Response(null, { status: 204 }));
    }

    // POST /api/login/action { session, action } -> browser submits user input.
    if (request.method === 'POST' && url.pathname === '/api/login/action') {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return json({ error: 'invalid json' }, 400);
      }
      const body = ActionBody.safeParse(raw);
      if (!body.success) return json({ error: 'invalid request' }, 400);
      const res = await loginStub(body.data.session).fetch(
        new Request('https://do/action', {
          method: 'POST',
          body: JSON.stringify(body.data.action)
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
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return json({ error: 'invalid json' }, 400);
      }
      const body = StatusBody.safeParse(raw);
      const parsed = body.success ? parseLoginStatus(body.data.status) : null;
      if (!body.success || parsed === null) {
        return json({ error: 'invalid request' }, 400);
      }
      const res = await loginStub(body.data.session).fetch(
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

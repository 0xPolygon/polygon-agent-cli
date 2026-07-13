// OIDC handoff relay (Cloudflare Worker + Durable Object).
//
// Purpose: let a CLI on ANY machine (including a remote server / openclaw) finish
// a browser OIDC login. Google can only redirect to a fixed public HTTPS URL and
// a localhost callback can't be reached when the browser is on a different
// machine than the CLI. So this relay sits at a public URL: it captures the
// OAuth `code`+`state` when the browser is redirected here, and the CLI POLLS for
// them, so there is no localhost dependency and it works local and remote alike.
//
// Security: the relay only ever sees `code`+`state`. The PKCE `code_verifier` and
// the wallet credential never leave the CLI, so a code alone cannot complete the
// login. Entries are short-lived (TTL) and the result is one-time read.
//
// Sessions are keyed by the OIDC `state` the CLI already holds (returned by
// startOidcRedirectAuth). That keeps the redirect target a single stable URL with
// no dynamic query, so the upstream relay only has to allowlist one path.
//
// Endpoints (all under /api/oidc):
//   POST /register  { state }                   (CLI: arm a handoff for this state)
//   GET  /cb?code&state  (or ?error&state)      (browser: the redirect lands here)
//   GET  /poll?state  -> { status, code?, state?, error? }   (CLI: poll for result)

import type { LoginAction } from './login-session.ts';

import { LoginSession, validLoginStatus } from './login-session.ts';
import { validReturnTo } from './return-to.ts';

export { LoginSession };

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes to complete the login

interface Env {
  OIDC_RELAY: DurableObjectNamespace;
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

// `state` is the SDK's base64url-encoded OIDC state. Bound it so a junk query
// can't be used to address arbitrary Durable Objects, and reject anything that
// isn't the shape we expect before using it as a DO name.
function validState(s: string | null): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= 4096 && /^[A-Za-z0-9_-]+$/.test(s);
}

function validSession(s: string | null): s is string {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(s);
}

// Shape-check browser-submitted actions before they reach the DO.
function validAction(a: unknown): a is LoginAction {
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
  return false;
}

const DONE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Login complete</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0a1f;color:#ece8f7;display:flex;
min-height:100vh;align-items:center;justify-content:center;margin:0}
.box{text-align:center;max-width:420px;padding:32px}h1{font-size:20px;margin:0 0 8px}
p{color:#9a92b8;font-size:14px;line-height:1.5}</style></head>
<body><div class="box"><h1>You're signed in</h1>
<p>Login complete. You can close this tab and return to your terminal.</p></div></body></html>`;

const FAIL_HTML = DONE_HTML.replace("You're signed in", 'Login failed').replace(
  'Login complete. You can close this tab and return to your terminal.',
  'Something went wrong. Return to your terminal for details.'
);

// Shown when the callback is hit again after the CLI already consumed the
// one-time session (a browser refresh/duplicate) or after it expired. Login is
// driven from the terminal, so this is neutral, not an error.
const CLOSE_HTML = DONE_HTML.replace("You're signed in", 'All set').replace(
  'Login complete. You can close this tab and return to your terminal.',
  'This sign-in link has already been used. Check your terminal — you can close this tab.'
);

// --- Durable Object: one instance per OIDC `state` ---
export class OidcHandoff {
  private state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const op = url.pathname; // internal path set by the router below

    if (op === '/register') {
      const returnTo = url.searchParams.get('returnTo');
      await this.state.storage.put('status', 'pending');
      if (returnTo) await this.state.storage.put('returnTo', returnTo);
      await this.state.storage.setAlarm(Date.now() + SESSION_TTL_MS);
      return new Response(null, { status: 204 });
    }

    if (op === '/capture') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      const status = await this.state.storage.get<string>('status');
      if (!status)
        return new Response(CLOSE_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } });
      const returnTo = await this.state.storage.get<string>('returnTo');
      if (error) {
        await this.state.storage.put({ status: 'error', error });
        // With a returnTo the branded page renders the failure (the CLI publishes
        // an error status); without one, keep the legacy inline page.
        if (returnTo) return Response.redirect(returnTo, 302);
        return new Response(FAIL_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } });
      }
      if (!code || !state) return new Response('missing code or state', { status: 400 });
      await this.state.storage.put({ status: 'ready', code, state });
      if (returnTo) return Response.redirect(returnTo, 302);
      return new Response(DONE_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }

    if (op === '/poll') {
      const status = await this.state.storage.get<string>('status');
      if (!status) return Response.json({ status: 'expired' });
      if (status === 'ready') {
        const [code, state] = await Promise.all([
          this.state.storage.get<string>('code'),
          this.state.storage.get<string>('state')
        ]);
        await this.state.storage.deleteAll(); // one-time read
        return Response.json({ status: 'ready', code, state });
      }
      if (status === 'error') {
        const error = await this.state.storage.get<string>('error');
        await this.state.storage.deleteAll();
        return Response.json({ status: 'error', error });
      }
      return Response.json({ status: 'pending' });
    }

    return new Response('not found', { status: 404 });
  }

  // TTL: drop the entry if the login never completes.
  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
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

    // POST /api/oidc/register { state } -> arm the DO for this state.
    // The CLI already holds `state` from startOidcRedirectAuth, so there is no
    // separate request id: the state IS the handle.
    if (request.method === 'POST' && url.pathname === '/api/oidc/register') {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid json' }, 400);
      }
      const state = (body as { state?: unknown } | null)?.state;
      if (!validState(typeof state === 'string' ? state : null)) {
        return json({ error: 'invalid state' }, 400);
      }
      const returnTo = (body as { returnTo?: unknown } | null)?.returnTo;
      if (returnTo !== undefined && !validReturnTo(returnTo)) {
        return json({ error: 'invalid returnTo' }, 400);
      }
      const stub = env.OIDC_RELAY.get(env.OIDC_RELAY.idFromName(state as string));
      const inner = new URL('https://do/register');
      if (returnTo) inner.searchParams.set('returnTo', returnTo as string);
      await stub.fetch(new Request(inner.toString(), { method: 'POST' }));
      return cors(new Response(null, { status: 204 }));
    }

    // GET /api/oidc/cb?code=...&state=...  (the browser's redirect target).
    // Serves HTML to the browser, so it is NOT CORS-wrapped.
    if (request.method === 'GET' && url.pathname === '/api/oidc/cb') {
      const state = url.searchParams.get('state');
      if (!validState(state)) return new Response('missing or invalid state', { status: 400 });
      const stub = env.OIDC_RELAY.get(env.OIDC_RELAY.idFromName(state));
      const inner = new URL('https://do/capture');
      inner.search = url.search; // forward code/state/error
      return stub.fetch(new Request(inner.toString(), { redirect: 'manual' }));
    }

    // GET /api/oidc/poll?state=...  (CLI polls for the result)
    if (request.method === 'GET' && url.pathname === '/api/oidc/poll') {
      const state = url.searchParams.get('state');
      if (!validState(state)) return json({ status: 'error', error: 'invalid state' }, 400);
      const stub = env.OIDC_RELAY.get(env.OIDC_RELAY.idFromName(state));
      const res = await stub.fetch(new Request('https://do/poll'));
      return cors(res);
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
      if (!validSession(session) || !validLoginStatus(body.status)) {
        return json({ error: 'invalid request' }, 400);
      }
      const res = await loginStub(session).fetch(
        new Request('https://do/set-status', {
          method: 'POST',
          body: JSON.stringify(body.status)
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

# Browser Login via agentconnect-ui Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `polygon-agent wallet login` open a branded login page on agentconnect-ui where the user picks Google or email; the CLI drives the SDK auth locally and a relay session carries user input from the page to the CLI.

**Architecture:** Device-flow pairing. The CLI generates a random session id, registers it with the oidc-relay worker (new `LoginSession` Durable Object), and opens `https://agentconnect.polygon.technology/login#<session>`. The page posts user actions (google / email+address / otp code / cancel) to the relay; the CLI polls for them, runs `startOidcRedirectAuth`/`completeOidcRedirectAuth` or `startEmailAuth`/`completeEmailAuth` locally, and publishes status back for the page to render. Keys and the PKCE verifier never leave the CLI. Spec: `docs/superpowers/specs/2026-07-13-browser-login-design.md`.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects (oidc-relay), React 18 + Vite (agentconnect-ui), yargs CLI, `@0xsequence/typescript-sdk` 0.1.0-alpha.4, vitest (new, per package).

## Global Constraints

- Dev environment is Node 24 (`.nvmrc`); published CLI supports Node 20+, TS compiled to es2023.
- Run the CLI from source with `tsx packages/polygon-agent-cli/src/index.ts` (never `node` directly on `.ts`).
- Conventional commit messages (`feat:`, `fix:`, `docs:`, `test:` with package scope). Never add a `Co-Authored-By` trailer.
- The pre-commit hook runs `pnpm -r run typecheck`; every commit must typecheck across all packages.
- No em dashes in any user-facing copy (UI text, CLI messages, docs). Sentence case for headings and labels.
- The canonical skill file is `packages/polygon-agent-cli/skills/SKILL.md`; never edit the root or connector-ui copies.
- Session ids and OIDC state are base64url; validate before using as Durable Object names.
- Vitest is new to this repo: each package that gains tests adds `"test": "vitest run"` and a `vitest` devDependency; the root `test` script (`pnpm -r --if-present run test`) picks them up automatically.

## Protocol reference (used by Tasks 1, 4, 6)

These two types are duplicated verbatim in each package (no shared workspace package exists; `packages/shared` is untracked dist-only debris, do not use it):

```ts
export type LoginAction =
  | { type: 'google' }
  | { type: 'email'; email: string }
  | { type: 'otp'; code: string }
  | { type: 'cancel' };

export type LoginStatus =
  | { status: 'awaiting-method' }
  | { status: 'auth-url'; url: string }
  | { status: 'otp-sent' }
  | { status: 'otp-invalid'; attemptsLeft?: number }
  | { status: 'done'; walletAddress: string }
  | { status: 'error'; message: string };
```

HTTP surface added to the relay (all JSON, CORS-wrapped like the existing `/api/oidc` routes):

| Route | Caller | Behavior |
|---|---|---|
| `POST /api/login/register {session}` | CLI | Arm the session, status becomes `awaiting-method`, 10 min TTL alarm. 204. |
| `POST /api/login/action {session, action}` | Browser | Store as the single pending action (latest wins). 204, or 404-shaped `{error:'expired'}` / `{error:'finished'}` JSON with status 410. |
| `GET /api/login/next-action?session=` | CLI | `{state:'action', action}` (one-time read), `{state:'pending'}`, or `{state:'expired'}`. |
| `POST /api/login/status {session, status...}` | CLI | Store status blob (repeat-readable). 204. |
| `GET /api/login/status?session=` | Browser | The stored `LoginStatus`, or `{status:'expired'}`. |

---

### Task 1: Relay LoginSession core logic with tests

**Files:**
- Create: `packages/oidc-relay/src/login-session.ts`
- Test: `packages/oidc-relay/src/login-session.test.ts`
- Modify: `packages/oidc-relay/package.json` (vitest devDep + test script)

**Interfaces:**
- Consumes: nothing (pure logic over a storage interface).
- Produces: `LoginSessionCore` class with `register()`, `submitAction(action): Promise<{ok: boolean; error?: 'expired'|'finished'}>`, `nextAction(): Promise<{state:'expired'}|{state:'pending'}|{state:'action'; action: LoginAction}>`, `setStatus(status)`, `getStatus(): Promise<LoginStatus | {status:'expired'}>`; `SessionStore` interface; `LoginAction`/`LoginStatus` types (exact shapes above). Task 2 wraps this in the Durable Object.

- [ ] **Step 1: Add vitest to the oidc-relay package**

In `packages/oidc-relay/package.json`, add to `scripts`:

```json
"test": "vitest run"
```

and to `devDependencies`:

```json
"vitest": "^3.0.0"
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing tests**

Create `packages/oidc-relay/src/login-session.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { LoginSessionCore, type SessionStore } from './login-session.ts';

function memoryStore(): SessionStore {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async (entries) => {
      for (const [k, v] of Object.entries(entries)) map.set(k, v);
    },
    delete: async (key) => map.delete(key),
    deleteAll: async () => map.clear()
  };
}

describe('LoginSessionCore', () => {
  it('reports expired before register', async () => {
    const core = new LoginSessionCore(memoryStore());
    expect(await core.getStatus()).toEqual({ status: 'expired' });
    expect(await core.nextAction()).toEqual({ state: 'expired' });
    expect(await core.submitAction({ type: 'google' })).toEqual({ ok: false, error: 'expired' });
  });

  it('register arms the session with awaiting-method', async () => {
    const core = new LoginSessionCore(memoryStore());
    await core.register();
    expect(await core.getStatus()).toEqual({ status: 'awaiting-method' });
    expect(await core.nextAction()).toEqual({ state: 'pending' });
  });

  it('actions are one-time reads', async () => {
    const core = new LoginSessionCore(memoryStore());
    await core.register();
    await core.submitAction({ type: 'email', email: 'a@b.co' });
    expect(await core.nextAction()).toEqual({
      state: 'action',
      action: { type: 'email', email: 'a@b.co' }
    });
    expect(await core.nextAction()).toEqual({ state: 'pending' });
  });

  it('a newer action replaces an unconsumed one (latest wins)', async () => {
    const core = new LoginSessionCore(memoryStore());
    await core.register();
    await core.submitAction({ type: 'google' });
    await core.submitAction({ type: 'cancel' });
    expect(await core.nextAction()).toEqual({ state: 'action', action: { type: 'cancel' } });
  });

  it('status round-trips and is repeat-readable', async () => {
    const core = new LoginSessionCore(memoryStore());
    await core.register();
    await core.setStatus({ status: 'otp-sent' });
    expect(await core.getStatus()).toEqual({ status: 'otp-sent' });
    expect(await core.getStatus()).toEqual({ status: 'otp-sent' });
  });

  it('rejects actions after a terminal status', async () => {
    const core = new LoginSessionCore(memoryStore());
    await core.register();
    await core.setStatus({ status: 'done', walletAddress: '0xabc' });
    expect(await core.submitAction({ type: 'otp', code: '123456' })).toEqual({
      ok: false,
      error: 'finished'
    });
    expect(await core.getStatus()).toEqual({ status: 'done', walletAddress: '0xabc' });
  });

  it('deleteAll expires everything (alarm behavior)', async () => {
    const store = memoryStore();
    const core = new LoginSessionCore(store);
    await core.register();
    await store.deleteAll();
    expect(await core.getStatus()).toEqual({ status: 'expired' });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @polygonlabs/oidc-relay test`
Expected: FAIL, cannot resolve `./login-session.ts`.

- [ ] **Step 4: Implement the core**

Create `packages/oidc-relay/src/login-session.ts`:

```ts
// Pairing-session logic for the browser login flow. Pure logic over a minimal
// storage interface so it is unit-testable without the Workers runtime; the
// Durable Object wrapper lives in relay.ts wiring (Task 2).
//
// One pending action slot, latest wins: the page waits for a status change
// before offering the next input, so at most one action is meaningfully in
// flight; a second submit (double click, cancel during OTP) should replace,
// not queue. Actions are one-time reads so an OTP can never be replayed.

export type LoginAction =
  | { type: 'google' }
  | { type: 'email'; email: string }
  | { type: 'otp'; code: string }
  | { type: 'cancel' };

export type LoginStatus =
  | { status: 'awaiting-method' }
  | { status: 'auth-url'; url: string }
  | { status: 'otp-sent' }
  | { status: 'otp-invalid'; attemptsLeft?: number }
  | { status: 'done'; walletAddress: string }
  | { status: 'error'; message: string };

export interface SessionStore {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
}

export class LoginSessionCore {
  constructor(private readonly store: SessionStore) {}

  async register(): Promise<void> {
    await this.store.put({ armed: true, status: { status: 'awaiting-method' } });
  }

  async submitAction(action: LoginAction): Promise<{ ok: boolean; error?: 'expired' | 'finished' }> {
    if (!(await this.store.get<boolean>('armed'))) return { ok: false, error: 'expired' };
    const status = await this.store.get<LoginStatus>('status');
    if (status && (status.status === 'done' || status.status === 'error')) {
      return { ok: false, error: 'finished' };
    }
    await this.store.put({ pendingAction: action });
    return { ok: true };
  }

  async nextAction(): Promise<
    { state: 'expired' } | { state: 'pending' } | { state: 'action'; action: LoginAction }
  > {
    if (!(await this.store.get<boolean>('armed'))) return { state: 'expired' };
    const action = await this.store.get<LoginAction>('pendingAction');
    if (!action) return { state: 'pending' };
    await this.store.delete('pendingAction');
    return { state: 'action', action };
  }

  async setStatus(status: LoginStatus): Promise<void> {
    await this.store.put({ status });
  }

  async getStatus(): Promise<LoginStatus | { status: 'expired' }> {
    if (!(await this.store.get<boolean>('armed'))) return { status: 'expired' };
    return (await this.store.get<LoginStatus>('status')) ?? { status: 'expired' };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @polygonlabs/oidc-relay test`
Expected: 7 passed.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm --filter @polygonlabs/oidc-relay typecheck
git add packages/oidc-relay/src/login-session.ts packages/oidc-relay/src/login-session.test.ts packages/oidc-relay/package.json pnpm-lock.yaml
git commit -m "feat(oidc-relay): LoginSession core for browser login pairing"
```

---

### Task 2: Relay LoginSession Durable Object, routes, and wrangler migration

**Files:**
- Modify: `packages/oidc-relay/src/relay.ts` (router additions near the end; DO export)
- Modify: `packages/oidc-relay/src/login-session.ts` (append DO wrapper)
- Modify: `packages/oidc-relay/wrangler.toml` (binding + v2 migrations, all envs)

**Interfaces:**
- Consumes: `LoginSessionCore`, `LoginAction` from Task 1; `cors`/`json` helpers already in `relay.ts`.
- Produces: the five `/api/login/*` HTTP routes exactly as in the protocol reference table. Tasks 4 and 7 call them.

- [ ] **Step 1: Append the DO wrapper to `login-session.ts`**

Add at the end of `packages/oidc-relay/src/login-session.ts`:

```ts
const SESSION_TTL_MS = 10 * 60 * 1000; // matches OidcHandoff

function doStore(storage: DurableObjectStorage): SessionStore {
  return {
    get: (key) => storage.get(key),
    put: (entries) => storage.put(entries),
    delete: (key) => storage.delete(key),
    deleteAll: () => storage.deleteAll()
  };
}

// --- Durable Object: one instance per login session id ---
export class LoginSession {
  private readonly core: LoginSessionCore;
  constructor(private readonly state: DurableObjectState) {
    this.core = new LoginSessionCore(doStore(state.storage));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const op = url.pathname; // internal path set by the router in relay.ts

    if (op === '/register') {
      await this.core.register();
      await this.state.storage.setAlarm(Date.now() + SESSION_TTL_MS);
      return new Response(null, { status: 204 });
    }
    if (op === '/action') {
      const action = (await request.json()) as LoginAction;
      const result = await this.core.submitAction(action);
      if (!result.ok) return Response.json({ error: result.error }, { status: 410 });
      return new Response(null, { status: 204 });
    }
    if (op === '/next-action') {
      return Response.json(await this.core.nextAction());
    }
    if (op === '/set-status') {
      await this.core.setStatus(await request.json());
      return new Response(null, { status: 204 });
    }
    if (op === '/get-status') {
      return Response.json(await this.core.getStatus());
    }
    return new Response('not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}
```

- [ ] **Step 2: Route `/api/login/*` in `relay.ts`**

In `packages/oidc-relay/src/relay.ts`:

Add to the imports at the top of the file:

```ts
import { LoginSession, type LoginAction } from './login-session.ts';

export { LoginSession };
```

Add `LOGIN_SESSION: DurableObjectNamespace;` to the `Env` interface:

```ts
interface Env {
  OIDC_RELAY: DurableObjectNamespace;
  LOGIN_SESSION: DurableObjectNamespace;
}
```

Add validators next to `validState` (session ids are 16 to 64 base64url chars; the CLI generates 22):

```ts
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
    return typeof email === 'string' && email.length >= 3 && email.length <= 320 && email.includes('@');
  }
  if (t === 'otp') {
    const code = (a as { code?: unknown }).code;
    return typeof code === 'string' && code.length >= 4 && code.length <= 16;
  }
  return false;
}
```

Add routes inside the default export's `fetch`, before the final `return new Response('not found', ...)`:

```ts
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
      if (!validSession(session) || typeof body.status !== 'object' || body.status === null) {
        return json({ error: 'invalid request' }, 400);
      }
      await loginStub(session).fetch(
        new Request('https://do/set-status', {
          method: 'POST',
          body: JSON.stringify(body.status)
        })
      );
      return cors(new Response(null, { status: 204 }));
    }

    // GET /api/login/status?session= -> browser polls state (repeat-readable).
    if (request.method === 'GET' && url.pathname === '/api/login/status') {
      const session = url.searchParams.get('session');
      if (!validSession(session)) return json({ status: 'error', message: 'invalid session' }, 400);
      return cors(await loginStub(session).fetch(new Request('https://do/get-status')));
    }
```

Note: the CLI sends the status blob nested under `status` and the worker forwards only that blob, so the DO stores a bare `LoginStatus`.

- [ ] **Step 3: Add the DO binding and migration to `wrangler.toml`**

In `packages/oidc-relay/wrangler.toml`, add a binding block after each existing `OIDC_RELAY` binding (top level, `env.staging`, `env.production`):

```toml
[[durable_objects.bindings]]
name = "LOGIN_SESSION"
class_name = "LoginSession"
```

(and the `[[env.staging.durable_objects.bindings]]` / `[[env.production.durable_objects.bindings]]` equivalents), plus a v2 migration after each v1 migration block:

```toml
[[migrations]]
tag = "v2"
new_classes = ["LoginSession"]
```

(again per env: `[[env.staging.migrations]]`, `[[env.production.migrations]]`).

- [ ] **Step 4: Typecheck and verify with wrangler dev**

```bash
pnpm --filter @polygonlabs/oidc-relay typecheck
```

Then start the worker locally and exercise the protocol end to end:

```bash
cd packages/oidc-relay && npx -y wrangler@3 dev --port 8788 &
sleep 8
S=abcdefghijklmnop123456
curl -s -X POST localhost:8788/api/login/register -H 'content-type: application/json' -d "{\"session\":\"$S\"}" -o /dev/null -w '%{http_code}\n'   # 204
curl -s "localhost:8788/api/login/status?session=$S"          # {"status":"awaiting-method"}
curl -s -X POST localhost:8788/api/login/action -H 'content-type: application/json' -d "{\"session\":\"$S\",\"action\":{\"type\":\"google\"}}" -o /dev/null -w '%{http_code}\n'  # 204
curl -s "localhost:8788/api/login/next-action?session=$S"     # {"state":"action","action":{"type":"google"}}
curl -s "localhost:8788/api/login/next-action?session=$S"     # {"state":"pending"}
curl -s -X POST localhost:8788/api/login/status -H 'content-type: application/json' -d "{\"session\":\"$S\",\"status\":{\"status\":\"done\",\"walletAddress\":\"0xabc\"}}" -o /dev/null -w '%{http_code}\n'  # 204
curl -s "localhost:8788/api/login/status?session=$S"          # {"status":"done","walletAddress":"0xabc"}
curl -s "localhost:8788/api/login/status?session=nope"        # 400
kill %1
```

Expected: outputs as annotated.

- [ ] **Step 5: Commit**

```bash
git add packages/oidc-relay/src/relay.ts packages/oidc-relay/src/login-session.ts packages/oidc-relay/wrangler.toml
git commit -m "feat(oidc-relay): /api/login pairing routes backed by LoginSession DO"
```

---

### Task 3: Relay OidcHandoff returnTo redirect

**Files:**
- Modify: `packages/oidc-relay/src/relay.ts` (OidcHandoff register/capture, register route)
- Create: `packages/oidc-relay/src/return-to.ts`
- Test: `packages/oidc-relay/src/return-to.test.ts`

**Interfaces:**
- Consumes: existing `OidcHandoff` DO and `/api/oidc/register` route.
- Produces: `POST /api/oidc/register` accepts optional `returnTo`; after capture the browser is 302-redirected there instead of getting `DONE_HTML`. `validReturnTo(raw: unknown): raw is string` exported from `return-to.ts`. Task 4's CLI client sends `returnTo`.

- [ ] **Step 1: Write the failing validator tests**

Create `packages/oidc-relay/src/return-to.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { validReturnTo } from './return-to.ts';

describe('validReturnTo', () => {
  it('accepts the production and staging login pages over https', () => {
    expect(validReturnTo('https://agentconnect.polygon.technology/login#abc')).toBe(true);
    expect(validReturnTo('https://agentconnect.staging.polygon.technology/login#abc')).toBe(true);
  });
  it('accepts localhost over http for local dev', () => {
    expect(validReturnTo('http://localhost:5173/login#abc')).toBe(true);
    expect(validReturnTo('http://127.0.0.1:5173/login#abc')).toBe(true);
  });
  it('rejects http on non-local hosts', () => {
    expect(validReturnTo('http://agentconnect.polygon.technology/login')).toBe(false);
  });
  it('rejects other hosts', () => {
    expect(validReturnTo('https://evil.example.com/login')).toBe(false);
    expect(validReturnTo('https://agentconnect.polygon.technology.evil.com/login')).toBe(false);
  });
  it('rejects non-URLs, non-strings, and oversized values', () => {
    expect(validReturnTo('not a url')).toBe(false);
    expect(validReturnTo(42)).toBe(false);
    expect(validReturnTo(`https://agentconnect.polygon.technology/${'a'.repeat(2050)}`)).toBe(false);
  });
});
```

Run: `pnpm --filter @polygonlabs/oidc-relay test`
Expected: FAIL, cannot resolve `./return-to.ts`.

- [ ] **Step 2: Implement the validator**

Create `packages/oidc-relay/src/return-to.ts`:

```ts
// Host allowlist for the post-capture redirect. Prevents the OIDC callback
// from being turned into an open redirect: only our login pages (plus
// localhost for dev) may be a returnTo target.

const ALLOWED_HOSTS = new Set([
  'agentconnect.polygon.technology',
  'agentconnect.staging.polygon.technology',
  'localhost',
  '127.0.0.1'
]);

export function validReturnTo(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) return false;
  return ALLOWED_HOSTS.has(url.hostname);
}
```

Run: `pnpm --filter @polygonlabs/oidc-relay test`
Expected: PASS (12 tests total with Task 1's).

- [ ] **Step 3: Thread returnTo through OidcHandoff**

In `packages/oidc-relay/src/relay.ts`:

Import the validator:

```ts
import { validReturnTo } from './return-to.ts';
```

In the `OidcHandoff` DO's `/register` op, store a `returnTo` passed via query (the router forwards it; empty means absent). Replace the existing `/register` block with:

```ts
    if (op === '/register') {
      const returnTo = url.searchParams.get('returnTo');
      await this.state.storage.put('status', 'pending');
      if (returnTo) await this.state.storage.put('returnTo', returnTo);
      await this.state.storage.setAlarm(Date.now() + SESSION_TTL_MS);
      return new Response(null, { status: 204 });
    }
```

In the `/capture` op, redirect to `returnTo` when present. Replace the two terminal responses (`FAIL_HTML` and `DONE_HTML`) inside `/capture` so both consult it:

```ts
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
```

In the router's `POST /api/oidc/register` handler, validate and forward `returnTo`. Replace the stub-fetch line:

```ts
      const returnTo = (body as { returnTo?: unknown } | null)?.returnTo;
      if (returnTo !== undefined && !validReturnTo(returnTo)) {
        return json({ error: 'invalid returnTo' }, 400);
      }
      const stub = env.OIDC_RELAY.get(env.OIDC_RELAY.idFromName(state as string));
      const inner = new URL('https://do/register');
      if (returnTo) inner.searchParams.set('returnTo', returnTo as string);
      await stub.fetch(new Request(inner.toString(), { method: 'POST' }));
      return cors(new Response(null, { status: 204 }));
```

Note: `/poll`'s `deleteAll()` on ready/error also drops `returnTo`, which is correct; a later duplicate callback gets `CLOSE_HTML` as today.

- [ ] **Step 4: Typecheck, verify old behavior intact with wrangler dev**

```bash
pnpm --filter @polygonlabs/oidc-relay typecheck
cd packages/oidc-relay && npx -y wrangler@3 dev --port 8788 &
sleep 8
# Without returnTo: legacy HTML behavior.
curl -s -X POST localhost:8788/api/oidc/register -H 'content-type: application/json' -d '{"state":"legacystate123"}' -o /dev/null -w '%{http_code}\n'   # 204
curl -s "localhost:8788/api/oidc/cb?code=c1&state=legacystate123" | grep -o "You're signed in"   # You're signed in
# With returnTo: 302 to the login page.
curl -s -X POST localhost:8788/api/oidc/register -H 'content-type: application/json' -d '{"state":"brandedstate123","returnTo":"https://agentconnect.polygon.technology/login#abc"}' -o /dev/null -w '%{http_code}\n'  # 204
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "localhost:8788/api/oidc/cb?code=c2&state=brandedstate123"  # 302 https://agentconnect.polygon.technology/login#abc
# Bad returnTo rejected.
curl -s -X POST localhost:8788/api/oidc/register -H 'content-type: application/json' -d '{"state":"badstate1234","returnTo":"https://evil.example.com/"}' -o /dev/null -w '%{http_code}\n'  # 400
kill %1
```

Expected: outputs as annotated.

- [ ] **Step 5: Commit**

```bash
git add packages/oidc-relay/src/relay.ts packages/oidc-relay/src/return-to.ts packages/oidc-relay/src/return-to.test.ts
git commit -m "feat(oidc-relay): optional returnTo redirect after OIDC capture"
```

---

### Task 4: CLI browser-login action loop with tests

**Files:**
- Create: `packages/polygon-agent-cli/src/lib/browser-login.ts`
- Create: `packages/polygon-agent-cli/src/lib/login-relay-client.ts`
- Modify: `packages/polygon-agent-cli/src/lib/oidc-relay-client.ts` (returnTo param on `registerRelaySession`)
- Test: `packages/polygon-agent-cli/src/lib/browser-login.test.ts`
- Modify: `packages/polygon-agent-cli/package.json` (vitest devDep + test script)

**Interfaces:**
- Consumes: relay HTTP routes from Tasks 2 and 3; SDK methods `startOidcRedirectAuth({provider, redirectUri, relayRedirectUri?}) -> {url, state}`, `completeOidcRedirectAuth({callbackUrl, walletSelection:'automatic'}) -> {walletAddress}`, `startEmailAuth({email}) -> void`, `completeEmailAuth({code, walletSelection:'automatic'}) -> {walletAddress}`.
- Produces: `runBrowserLogin(deps: BrowserLoginDeps, opts: BrowserLoginOpts): Promise<{walletAddress: string; loginMethod: 'google' | 'email'}>` and the `BrowserLoginDeps`/`BrowserLoginOpts` interfaces; `makeLoginRelay(relayBase: string): BrowserLoginDeps['relay']` from `login-relay-client.ts`. Task 5 wires these into `wallet login`.

- [ ] **Step 1: Add vitest to the CLI package**

In `packages/polygon-agent-cli/package.json`, add to `scripts`:

```json
"test": "vitest run"
```

and to `devDependencies`:

```json
"vitest": "^3.0.0"
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing tests**

Create `packages/polygon-agent-cli/src/lib/browser-login.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  runBrowserLogin,
  type BrowserLoginDeps,
  type BrowserLoginOpts,
  type LoginAction,
  type LoginStatus
} from './browser-login.ts';

// A scripted fake: nextAction() pops the queue (null = pending tick), and every
// published status is recorded for assertions.
function makeFakes(actionQueue: Array<LoginAction | null>) {
  const statuses: LoginStatus[] = [];
  const calls: string[] = [];
  let time = 0;

  const deps: BrowserLoginDeps = {
    relay: {
      registerSession: async () => {
        calls.push('registerSession');
      },
      nextAction: async () => (actionQueue.length > 0 ? (actionQueue.shift() ?? null) : null),
      setStatus: async (_s, status) => {
        statuses.push(status);
      },
      registerOidcHandoff: async (state, returnTo) => {
        calls.push(`registerOidcHandoff:${state}:${returnTo}`);
      },
      pollOidcCallback: async () => ({ code: 'CODE1', state: 'STATE1' })
    },
    wallet: {
      startOidcRedirectAuth: async () => ({ url: 'https://accounts.google.com/auth', state: 'STATE1' }),
      completeOidcRedirectAuth: async (p) => {
        calls.push(`completeOidc:${p.callbackUrl}`);
        return { walletAddress: '0xW' };
      },
      startEmailAuth: async (p) => {
        calls.push(`startEmail:${p.email}`);
      },
      completeEmailAuth: async (p) => {
        calls.push(`completeEmail:${p.code}`);
        if (p.code === 'BAD') throw new Error('invalid code');
        return { walletAddress: '0xW' };
      }
    },
    announce: async (url) => {
      calls.push(`announce:${url}`);
    },
    sleep: async () => {
      time += 1000;
    },
    now: () => time,
    randomSessionId: () => 'sessionid12345678'
  };
  return { deps, statuses, calls };
}

const OPTS: BrowserLoginOpts = {
  relayBase: 'https://relay.test',
  uiBase: 'https://ui.test',
  timeoutMs: 60_000
};

describe('runBrowserLogin', () => {
  it('completes the google flow', async () => {
    const { deps, statuses, calls } = makeFakes([{ type: 'google' }]);
    const result = await runBrowserLogin(deps, OPTS);

    expect(result).toEqual({ walletAddress: '0xW', loginMethod: 'google' });
    expect(calls).toContain('announce:https://ui.test/login#sessionid12345678');
    expect(calls).toContain('registerOidcHandoff:STATE1:https://ui.test/login#sessionid12345678');
    expect(calls).toContain('completeOidc:https://relay.test/api/oidc/cb?code=CODE1&state=STATE1');
    expect(statuses).toEqual([
      { status: 'auth-url', url: 'https://accounts.google.com/auth' },
      { status: 'done', walletAddress: '0xW' }
    ]);
  });

  it('completes the email flow', async () => {
    const { deps, statuses, calls } = makeFakes([
      { type: 'email', email: 'a@b.co' },
      { type: 'otp', code: '123456' }
    ]);
    const result = await runBrowserLogin(deps, OPTS);

    expect(result).toEqual({ walletAddress: '0xW', loginMethod: 'email' });
    expect(calls).toContain('startEmail:a@b.co');
    expect(calls).toContain('completeEmail:123456');
    expect(statuses).toEqual([{ status: 'otp-sent' }, { status: 'done', walletAddress: '0xW' }]);
  });

  it('publishes otp-invalid and accepts a retried code', async () => {
    const { deps, statuses } = makeFakes([
      { type: 'email', email: 'a@b.co' },
      { type: 'otp', code: 'BAD' },
      { type: 'otp', code: '123456' }
    ]);
    const result = await runBrowserLogin(deps, OPTS);

    expect(result.loginMethod).toBe('email');
    expect(statuses).toEqual([
      { status: 'otp-sent' },
      { status: 'otp-invalid', attemptsLeft: 2 },
      { status: 'done', walletAddress: '0xW' }
    ]);
  });

  it('fails after three bad codes', async () => {
    const { deps, statuses } = makeFakes([
      { type: 'email', email: 'a@b.co' },
      { type: 'otp', code: 'BAD' },
      { type: 'otp', code: 'BAD' },
      { type: 'otp', code: 'BAD' }
    ]);
    await expect(runBrowserLogin(deps, OPTS)).rejects.toThrow(/too many invalid codes/i);
    expect(statuses.at(-1)).toMatchObject({ status: 'error' });
  });

  it('throws when the user cancels on the page', async () => {
    const { deps, statuses } = makeFakes([{ type: 'cancel' }]);
    await expect(runBrowserLogin(deps, OPTS)).rejects.toThrow(/cancelled/i);
    expect(statuses.at(-1)).toMatchObject({ status: 'error' });
  });

  it('times out when no action ever arrives', async () => {
    const { deps } = makeFakes([]);
    await expect(runBrowserLogin(deps, { ...OPTS, timeoutMs: 5000 })).rejects.toThrow(/timed out/i);
  });

  it('propagates a relay registration failure', async () => {
    const { deps } = makeFakes([]);
    deps.relay.registerSession = async () => {
      throw new Error('Relay register failed (503)');
    };
    await expect(runBrowserLogin(deps, OPTS)).rejects.toThrow(/Relay register failed/);
  });
});
```

Run: `pnpm --filter @polygonlabs/agent-cli test`
Expected: FAIL, cannot resolve `./browser-login.ts`.

- [ ] **Step 3: Implement the loop**

Create `packages/polygon-agent-cli/src/lib/browser-login.ts`:

```ts
// The browser-login action loop: the branded page (agentconnect-ui /login) is
// the input surface, the relay carries user actions here, and this process
// drives the actual SDK auth so keys and the PKCE verifier never leave the
// machine. Pure orchestration over injected deps so it is unit-testable.

export type LoginAction =
  | { type: 'google' }
  | { type: 'email'; email: string }
  | { type: 'otp'; code: string }
  | { type: 'cancel' };

export type LoginStatus =
  | { status: 'awaiting-method' }
  | { status: 'auth-url'; url: string }
  | { status: 'otp-sent' }
  | { status: 'otp-invalid'; attemptsLeft?: number }
  | { status: 'done'; walletAddress: string }
  | { status: 'error'; message: string };

export interface BrowserLoginDeps {
  relay: {
    registerSession(session: string): Promise<void>;
    nextAction(session: string): Promise<LoginAction | null>;
    setStatus(session: string, status: LoginStatus): Promise<void>;
    registerOidcHandoff(state: string, returnTo: string): Promise<void>;
    pollOidcCallback(state: string, timeoutMs: number): Promise<{ code: string; state: string }>;
  };
  wallet: {
    startOidcRedirectAuth(p: {
      provider: 'google';
      redirectUri: string;
      relayRedirectUri?: string;
    }): Promise<{ url: string; state: string }>;
    completeOidcRedirectAuth(p: {
      callbackUrl: string;
      walletSelection: 'automatic';
    }): Promise<{ walletAddress: string }>;
    startEmailAuth(p: { email: string }): Promise<void>;
    completeEmailAuth(p: {
      code: string;
      walletSelection: 'automatic';
    }): Promise<{ walletAddress: string }>;
  };
  announce(url: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  randomSessionId(): string;
}

export interface BrowserLoginOpts {
  relayBase: string;
  uiBase: string;
  seqRelay?: string;
  timeoutMs: number;
  pollIntervalMs?: number;
}

const MAX_OTP_ATTEMPTS = 3;

export async function runBrowserLogin(
  deps: BrowserLoginDeps,
  opts: BrowserLoginOpts
): Promise<{ walletAddress: string; loginMethod: 'google' | 'email' }> {
  const { relay, wallet } = deps;
  const interval = opts.pollIntervalMs ?? 2000;
  const session = deps.randomSessionId();
  const pageUrl = `${opts.uiBase}/login#${session}`;
  const deadline = deps.now() + opts.timeoutMs;

  await relay.registerSession(session);
  await deps.announce(pageUrl);

  // Publish a terminal error so the page does not sit on a spinner, then throw.
  const fail = async (message: string): Promise<never> => {
    try {
      await relay.setStatus(session, { status: 'error', message });
    } catch {
      // Best-effort: the CLI error below is the source of truth.
    }
    throw new Error(message);
  };

  let otpFailures = 0;

  while (deps.now() < deadline) {
    const action = await relay.nextAction(session);
    if (!action) {
      await deps.sleep(interval);
      continue;
    }

    if (action.type === 'cancel') {
      return fail('Login cancelled in the browser.');
    }

    if (action.type === 'google') {
      const { url, state } = await wallet.startOidcRedirectAuth({
        provider: 'google',
        redirectUri: `${opts.relayBase}/api/oidc/cb`,
        ...(opts.seqRelay ? { relayRedirectUri: opts.seqRelay } : {})
      });
      await relay.registerOidcHandoff(state, pageUrl);
      await relay.setStatus(session, { status: 'auth-url', url });
      try {
        const cb = await relay.pollOidcCallback(state, Math.max(deadline - deps.now(), 1));
        const callbackUrl = `${opts.relayBase}/api/oidc/cb?code=${encodeURIComponent(cb.code)}&state=${encodeURIComponent(cb.state)}`;
        const result = await wallet.completeOidcRedirectAuth({
          callbackUrl,
          walletSelection: 'automatic'
        });
        await relay.setStatus(session, { status: 'done', walletAddress: result.walletAddress });
        return { walletAddress: result.walletAddress, loginMethod: 'google' };
      } catch (error) {
        return fail((error as Error).message);
      }
    }

    if (action.type === 'email') {
      try {
        await wallet.startEmailAuth({ email: action.email });
        otpFailures = 0;
        await relay.setStatus(session, { status: 'otp-sent' });
      } catch (error) {
        return fail((error as Error).message);
      }
      continue;
    }

    // action.type === 'otp'
    try {
      const result = await wallet.completeEmailAuth({
        code: action.code,
        walletSelection: 'automatic'
      });
      await relay.setStatus(session, { status: 'done', walletAddress: result.walletAddress });
      return { walletAddress: result.walletAddress, loginMethod: 'email' };
    } catch {
      otpFailures += 1;
      if (otpFailures >= MAX_OTP_ATTEMPTS) {
        return fail('Login failed: too many invalid codes.');
      }
      await relay.setStatus(session, {
        status: 'otp-invalid',
        attemptsLeft: MAX_OTP_ATTEMPTS - otpFailures
      });
    }
  }

  return fail('Timed out waiting for browser login. Re-run, or use `wallet login --local`.');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @polygonlabs/agent-cli test`
Expected: 7 passed.

- [ ] **Step 5: Implement the HTTP relay client**

Create `packages/polygon-agent-cli/src/lib/login-relay-client.ts`:

```ts
// HTTP client for the relay's /api/login pairing routes (packages/oidc-relay).
// Produces the `relay` dependency for runBrowserLogin; the OIDC handoff pieces
// reuse the existing oidc-relay-client functions.

import type { BrowserLoginDeps, LoginAction, LoginStatus } from './browser-login.ts';
import { pollRelayForCallback, registerRelaySession } from './oidc-relay-client.ts';

export function makeLoginRelay(relayBase: string): BrowserLoginDeps['relay'] {
  return {
    async registerSession(session: string): Promise<void> {
      const res = await fetch(`${relayBase}/api/login/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session })
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(
          `Relay register failed (${res.status}). Check POLYGON_AGENT_OIDC_RELAY / --relay-url, or use --local.`
        );
      }
    },

    async nextAction(session: string): Promise<LoginAction | null> {
      const res = await fetch(
        `${relayBase}/api/login/next-action?session=${encodeURIComponent(session)}`
      );
      if (!res.ok) throw new Error(`Relay poll failed (${res.status})`);
      const data = (await res.json()) as { state: string; action?: LoginAction };
      if (data.state === 'expired') {
        throw new Error('Login session expired before completion. Re-run `wallet login`.');
      }
      return data.state === 'action' && data.action ? data.action : null;
    },

    async setStatus(session: string, status: LoginStatus): Promise<void> {
      const res = await fetch(`${relayBase}/api/login/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session, status })
      });
      if (!res.ok && res.status !== 204) throw new Error(`Relay status update failed (${res.status})`);
    },

    registerOidcHandoff(state: string, returnTo: string): Promise<void> {
      return registerRelaySession(relayBase, state, returnTo);
    },

    pollOidcCallback(state: string, timeoutMs: number): Promise<{ code: string; state: string }> {
      return pollRelayForCallback(relayBase, state, { timeoutMs });
    }
  };
}
```

- [ ] **Step 6: Add the returnTo parameter to `registerRelaySession`**

In `packages/polygon-agent-cli/src/lib/oidc-relay-client.ts`, change the signature and body of `registerRelaySession`:

```ts
export async function registerRelaySession(
  relayBase: string,
  state: string,
  returnTo?: string
): Promise<void> {
  const res = await fetch(`${relayBase}/api/oidc/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(returnTo ? { state, returnTo } : { state })
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(
      `Relay register failed (${res.status}). Check POLYGON_AGENT_OIDC_RELAY / --relay-url.`
    );
  }
}
```

(The existing call site in `wallet.ts` passes two arguments and is unaffected.)

- [ ] **Step 7: Typecheck, test, commit**

```bash
pnpm --filter @polygonlabs/agent-cli typecheck && pnpm --filter @polygonlabs/agent-cli test
git add packages/polygon-agent-cli/src/lib/browser-login.ts packages/polygon-agent-cli/src/lib/browser-login.test.ts packages/polygon-agent-cli/src/lib/login-relay-client.ts packages/polygon-agent-cli/src/lib/oidc-relay-client.ts packages/polygon-agent-cli/package.json pnpm-lock.yaml
git commit -m "feat(cli): browser-login action loop and login relay client"
```

---

### Task 5: Wire browser login into `wallet login` and update docs

**Files:**
- Modify: `packages/polygon-agent-cli/src/lib/oms-client.ts` (baked-in defaults, `loginUiBaseUrl`)
- Modify: `packages/polygon-agent-cli/src/commands/wallet.ts` (flags, handleLogin)
- Modify: `packages/polygon-agent-cli/README.md` (login section)
- Modify: `packages/polygon-agent-cli/skills/SKILL.md` (login section; this is the canonical copy)
- Modify: `CLAUDE.md` (wallet auth section)

**Interfaces:**
- Consumes: `runBrowserLogin`, `makeLoginRelay` (Task 4); existing `announceAuthUrl`, `saveOmsWalletPointer`, `showFunding`, `getOmsClient`, `startOidcCallbackServer`.
- Produces: `wallet login` defaults to the browser flow; `--local` keeps the loopback flow; `oidcRelayBaseUrl(): string` (now never undefined) and `loginUiBaseUrl(): string` exported from `oms-client.ts`.

- [ ] **Step 1: Bake in default relay and UI URLs**

In `packages/polygon-agent-cli/src/lib/oms-client.ts`, replace `oidcRelayBaseUrl` and add `loginUiBaseUrl`:

```ts
// Production defaults for the browser-login flow. The relay custom domain and
// the Sequence allowlist entry for its /api/oidc/cb are deploy prerequisites
// (see docs/superpowers/specs/2026-07-13-browser-login-design.md). Override per
// environment with POLYGON_AGENT_OIDC_RELAY / POLYGON_AGENT_LOGIN_UI.
const DEFAULT_OIDC_RELAY = 'https://oidc-relay.polygon.technology';
const DEFAULT_LOGIN_UI = 'https://agentconnect.polygon.technology';

/**
 * Base URL of OUR OIDC handoff + login relay (packages/oidc-relay). Read from
 * POLYGON_AGENT_OIDC_RELAY with a production default; `--relay-url` overrides
 * per-run. Trailing slash trimmed so callers can append `/api/...` cleanly.
 */
export function oidcRelayBaseUrl(): string {
  const v = process.env.POLYGON_AGENT_OIDC_RELAY;
  return v ? v.replace(/\/+$/, '') : DEFAULT_OIDC_RELAY;
}

/** Base URL of the agentconnect login page. POLYGON_AGENT_LOGIN_UI overrides. */
export function loginUiBaseUrl(): string {
  const v = process.env.POLYGON_AGENT_LOGIN_UI;
  return v ? v.replace(/\/+$/, '') : DEFAULT_LOGIN_UI;
}
```

(Keep `oidcRelayRedirectUri()` as is.)

- [ ] **Step 2: Rework `handleLogin` in `wallet.ts`**

In `packages/polygon-agent-cli/src/commands/wallet.ts`:

Update imports:

```ts
import { randomBytes } from 'node:crypto';

import { runBrowserLogin } from '../lib/browser-login.ts';
import { makeLoginRelay } from '../lib/login-relay-client.ts';
import { startOidcCallbackServer } from '../lib/oidc-callback-server.ts';
import { getOmsClient, loginUiBaseUrl, oidcRelayBaseUrl, oidcRelayRedirectUri } from '../lib/oms-client.ts';
```

(`registerRelaySession`/`pollRelayForCallback` are no longer imported here; the old `--remote` branch goes away.)

Update `LoginArgs`:

```ts
interface LoginArgs {
  name: string;
  provider: string;
  port: number;
  timeout: number;
  force: boolean;
  fund: boolean;
  local: boolean;
  remote: boolean;
  relayUrl?: string;
}
```

Replace `obtainBrowserCallbackUrl` with a loopback-only version (the relay-polling branch is superseded by the browser flow):

```ts
// Legacy --local flow: a short-lived loopback server; the relay bounces the
// browser to it. Only works when the browser runs on this machine.
async function obtainLoopbackCallbackUrl(
  oms: ReturnType<typeof getOmsClient>,
  provider: 'google',
  argv: LoginArgs
): Promise<string> {
  const seqRelay = oidcRelayRedirectUri();
  const server = await startOidcCallbackServer({
    port: argv.port,
    timeoutMs: argv.timeout * 1000
  });
  try {
    const { url } = await oms.wallet.startOidcRedirectAuth({
      provider,
      redirectUri: server.redirectUri,
      ...(seqRelay ? { relayRedirectUri: seqRelay } : {})
    });
    await announceAuthUrl(url);
    return await server.waitForCallbackUrl;
  } finally {
    server.close();
  }
}
```

Replace `handleLogin` with:

```ts
async function handleLogin(argv: LoginArgs): Promise<void> {
  try {
    const oms = getOmsClient(argv.name);

    // Short-circuit if already logged in (the SDK restores the session from
    // storage on construction). Starting a new auth would clearSession(), so
    // re-login is opt-in via --force.
    if (!argv.force && oms.wallet.walletAddress) {
      jsonOut({
        ok: true,
        walletName: argv.name,
        walletAddress: oms.wallet.walletAddress,
        alreadyLoggedIn: true
      });
      return;
    }

    let walletAddress: string;
    let loginMethod: string;

    if (argv.local) {
      if (argv.provider !== 'google') {
        throw new Error(`Unsupported provider "${argv.provider}". Only "google" works with --local.`);
      }
      const callbackUrl = await obtainLoopbackCallbackUrl(oms, 'google', argv);
      const result = await oms.wallet.completeOidcRedirectAuth({
        callbackUrl,
        walletSelection: 'automatic'
      });
      walletAddress = result.walletAddress;
      loginMethod = 'google';
    } else {
      if (argv.remote) {
        process.stderr.write('--remote is deprecated: the default login already works remotely.\n');
      }
      const relayBase = argv.relayUrl?.replace(/\/+$/, '') || oidcRelayBaseUrl();
      const result = await runBrowserLogin(
        {
          relay: makeLoginRelay(relayBase),
          wallet: oms.wallet,
          announce: announceAuthUrl,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now: () => Date.now(),
          randomSessionId: () => randomBytes(16).toString('base64url')
        },
        {
          relayBase,
          uiBase: loginUiBaseUrl(),
          seqRelay: oidcRelayRedirectUri(),
          timeoutMs: argv.timeout * 1000
        }
      );
      walletAddress = result.walletAddress;
      loginMethod = result.loginMethod;
    }

    await saveOmsWalletPointer(argv.name, {
      walletAddress,
      loginMethod,
      createdAt: new Date().toISOString()
    });

    jsonOut({ ok: true, walletName: argv.name, walletAddress, loginMethod });

    // Funding: the login page's success screen already directs the user onward,
    // so the browser flow only prints the panel; --local keeps opening the page.
    if (argv.fund !== false) {
      await showFunding(argv.name, walletAddress, 137, { openBrowser: argv.local });
    }
  } catch (error) {
    jsonOut({ ok: false, error: (error as Error).message });
    process.exit(1);
  }
}
```

Type note: `oms.wallet` satisfies `BrowserLoginDeps['wallet']` structurally (the SDK methods accept supersets of the params and return supersets of the results). If tsc complains about the overloaded `completeEmailAuth`/`completeOidcRedirectAuth`, wrap the two methods explicitly:

```ts
          wallet: {
            startOidcRedirectAuth: (p) => oms.wallet.startOidcRedirectAuth(p),
            completeOidcRedirectAuth: (p) => oms.wallet.completeOidcRedirectAuth(p),
            startEmailAuth: (p) => oms.wallet.startEmailAuth(p),
            completeEmailAuth: (p) => oms.wallet.completeEmailAuth(p)
          },
```

- [ ] **Step 3: Update the yargs login builder**

In the `wallet login` command builder in `wallet.ts`:

- `describe` for `login`: `'Log in in the browser (choose Google or email on the login page)'`
- `provider` option describe: `'OIDC provider for --local (the browser flow picks the method on the page)'`
- `timeout` default: `600`, describe: `'Seconds to wait for the browser login before giving up'`
- `remote` option describe: `'(deprecated) the default flow already works remotely'`
- Add after the `remote` option:

```ts
            .option('local', {
              type: 'boolean',
              default: false,
              describe:
                'Legacy loopback flow: raw Google URL + localhost callback (browser must be on this machine)'
            })
```

- `relay-url` describe: `'Relay base URL (overrides POLYGON_AGENT_OIDC_RELAY)'`

- [ ] **Step 4: Typecheck, test, and smoke-check the fallback**

```bash
pnpm --filter @polygonlabs/agent-cli typecheck && pnpm --filter @polygonlabs/agent-cli test
tsx packages/polygon-agent-cli/src/index.ts wallet login --help
```

Expected: help shows `--local`, `--remote` marked deprecated, timeout default 600.

Smoke-check the browser flow against the local relay from Task 2 (no real login, just the announce + poll wiring):

```bash
cd packages/oidc-relay && npx -y wrangler@3 dev --port 8788 &
sleep 8
cd ../..
POLYGON_AGENT_OIDC_RELAY=http://localhost:8788 POLYGON_AGENT_LOGIN_UI=http://localhost:5173 \
  timeout 15 tsx packages/polygon-agent-cli/src/index.ts wallet login --name plan-smoke --timeout 10 --no-fund
kill %1
```

Expected: prints `Open this URL to sign in:` with `http://localhost:5173/login#<22-char id>`, then times out after ~10s with `{"ok":false,"error":"Timed out waiting for browser login. Re-run, or use `wallet login --local`."}`. (Requires `SEQUENCE_PUBLISHABLE_KEY` configured, as any login does. Clean up with `rm -rf ~/.polygon-agent/oms/plan-smoke ~/.polygon-agent/wallets/plan-smoke.json` if created.)

- [ ] **Step 5: Update docs**

- `packages/polygon-agent-cli/README.md`: in the wallet login section, describe the new default (browser page with Google or email, works local and remote), the `--local` fallback, the `--remote` deprecation, and the `POLYGON_AGENT_LOGIN_UI` env var.
- `packages/polygon-agent-cli/skills/SKILL.md`: update the `wallet login` command description the same way (canonical copy only).
- `CLAUDE.md` (repo root): update the "Wallet auth (OMS V3)" bullet: login opens the agentconnect login page by default (Google or email chosen there); `--local` is the loopback fallback; `--remote` deprecated.

No em dashes in any of the new copy.

- [ ] **Step 6: Commit**

```bash
git add packages/polygon-agent-cli/src/commands/wallet.ts packages/polygon-agent-cli/src/lib/oms-client.ts packages/polygon-agent-cli/README.md packages/polygon-agent-cli/skills/SKILL.md CLAUDE.md
git commit -m "feat(cli): wallet login defaults to the agentconnect browser flow"
```

---

### Task 6: UI login state machine with tests

**Files:**
- Create: `packages/agentconnect-ui/src/login/machine.ts`
- Test: `packages/agentconnect-ui/src/login/machine.test.ts`
- Modify: `packages/agentconnect-ui/package.json` (vitest devDep + test script)

**Interfaces:**
- Consumes: nothing (pure reducer).
- Produces: `MachineState`, `MachineEvent`, `reduce(state, event): MachineState`, `initialState`; `RelayStatus` type (LoginStatus plus `{status:'expired'}`). Task 7's component drives this.

- [ ] **Step 1: Add vitest to agentconnect-ui**

In `packages/agentconnect-ui/package.json`, add to `scripts`:

```json
"test": "vitest run"
```

and to `devDependencies`:

```json
"vitest": "^3.0.0"
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing tests**

Create `packages/agentconnect-ui/src/login/machine.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { initialState, reduce, type MachineState } from './machine.ts';

describe('login machine', () => {
  it('google: method -> google-wait -> success', () => {
    let s: MachineState = initialState;
    s = reduce(s, { type: 'choose-google' });
    expect(s).toEqual({ kind: 'google-wait' });
    s = reduce(s, { type: 'status', status: { status: 'done', walletAddress: '0xW' } });
    expect(s).toEqual({ kind: 'success', walletAddress: '0xW' });
  });

  it('email: full path with an otp retry', () => {
    let s: MachineState = initialState;
    s = reduce(s, { type: 'choose-email' });
    expect(s).toEqual({ kind: 'email-entry' });
    s = reduce(s, { type: 'submit-email', email: 'a@b.co' });
    expect(s).toEqual({ kind: 'email-wait', email: 'a@b.co' });
    s = reduce(s, { type: 'status', status: { status: 'otp-sent' } });
    expect(s).toEqual({ kind: 'otp-entry', email: 'a@b.co' });
    s = reduce(s, { type: 'submit-otp', code: '111111' });
    expect(s).toEqual({ kind: 'otp-wait', email: 'a@b.co' });
    s = reduce(s, { type: 'status', status: { status: 'otp-invalid', attemptsLeft: 2 } });
    expect(s).toEqual({ kind: 'otp-entry', email: 'a@b.co', attemptsLeft: 2, invalid: true });
    s = reduce(s, { type: 'submit-otp', code: '222222' });
    s = reduce(s, { type: 'status', status: { status: 'done', walletAddress: '0xW' } });
    expect(s).toEqual({ kind: 'success', walletAddress: '0xW' });
  });

  it('expired and error statuses are terminal from any state', () => {
    expect(reduce(initialState, { type: 'status', status: { status: 'expired' } })).toEqual({
      kind: 'expired'
    });
    expect(
      reduce({ kind: 'otp-wait', email: 'a@b.co' }, { type: 'status', status: { status: 'error', message: 'boom' } })
    ).toEqual({ kind: 'failed', message: 'boom' });
  });

  it('reconciles a refreshed page from the polled status', () => {
    // After a refresh the page is back at `method`; the poll snaps it forward.
    expect(reduce(initialState, { type: 'status', status: { status: 'otp-sent' } })).toEqual({
      kind: 'otp-entry',
      email: ''
    });
    expect(
      reduce(initialState, { type: 'status', status: { status: 'done', walletAddress: '0xW' } })
    ).toEqual({ kind: 'success', walletAddress: '0xW' });
  });

  it('back returns from email entry to method choice', () => {
    expect(reduce({ kind: 'email-entry' }, { type: 'back' })).toEqual({ kind: 'method' });
  });

  it('awaiting-method and stale statuses do not regress the ui', () => {
    expect(
      reduce({ kind: 'email-entry' }, { type: 'status', status: { status: 'awaiting-method' } })
    ).toEqual({ kind: 'email-entry' });
    // auth-url is handled as a side effect (redirect); state is unchanged.
    expect(
      reduce({ kind: 'google-wait' }, { type: 'status', status: { status: 'auth-url', url: 'https://x' } })
    ).toEqual({ kind: 'google-wait' });
  });
});
```

Run: `pnpm --filter @polygonlabs/agentconnect-ui test`
Expected: FAIL, cannot resolve `./machine.ts`.

- [ ] **Step 3: Implement the machine**

Create `packages/agentconnect-ui/src/login/machine.ts`:

```ts
// Pure state machine for the /login page. The component polls the relay and
// feeds statuses in as events alongside user input; side effects (posting
// actions, redirecting to the auth url) live in the component, not here.

export type LoginStatus =
  | { status: 'awaiting-method' }
  | { status: 'auth-url'; url: string }
  | { status: 'otp-sent' }
  | { status: 'otp-invalid'; attemptsLeft?: number }
  | { status: 'done'; walletAddress: string }
  | { status: 'error'; message: string };

export type RelayStatus = LoginStatus | { status: 'expired' };

export type MachineState =
  | { kind: 'method' }
  | { kind: 'google-wait' }
  | { kind: 'email-entry' }
  | { kind: 'email-wait'; email: string }
  | { kind: 'otp-entry'; email: string; invalid?: boolean; attemptsLeft?: number }
  | { kind: 'otp-wait'; email: string }
  | { kind: 'success'; walletAddress: string }
  | { kind: 'expired' }
  | { kind: 'failed'; message: string };

export type MachineEvent =
  | { type: 'status'; status: RelayStatus }
  | { type: 'choose-google' }
  | { type: 'choose-email' }
  | { type: 'submit-email'; email: string }
  | { type: 'submit-otp'; code: string }
  | { type: 'back' };

export const initialState: MachineState = { kind: 'method' };

function emailOf(state: MachineState): string {
  return 'email' in state ? state.email : '';
}

export function reduce(state: MachineState, event: MachineEvent): MachineState {
  if (event.type === 'status') {
    const s = event.status;
    // Terminal statuses win from anywhere.
    if (s.status === 'expired') return { kind: 'expired' };
    if (s.status === 'error') return { kind: 'failed', message: s.message };
    if (s.status === 'done') return { kind: 'success', walletAddress: s.walletAddress };
    // otp-sent snaps forward (also reconciles a refreshed page).
    if (s.status === 'otp-sent') {
      if (state.kind === 'otp-entry' || state.kind === 'otp-wait') return state;
      return { kind: 'otp-entry', email: emailOf(state) };
    }
    if (s.status === 'otp-invalid' && state.kind === 'otp-wait') {
      return { kind: 'otp-entry', email: state.email, invalid: true, attemptsLeft: s.attemptsLeft };
    }
    // awaiting-method and auth-url never regress the ui.
    return state;
  }

  switch (event.type) {
    case 'choose-google':
      return state.kind === 'method' ? { kind: 'google-wait' } : state;
    case 'choose-email':
      return state.kind === 'method' ? { kind: 'email-entry' } : state;
    case 'submit-email':
      return state.kind === 'email-entry' ? { kind: 'email-wait', email: event.email } : state;
    case 'submit-otp':
      return state.kind === 'otp-entry' ? { kind: 'otp-wait', email: state.email } : state;
    case 'back':
      return state.kind === 'email-entry' ? { kind: 'method' } : state;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @polygonlabs/agentconnect-ui test`
Expected: 6 passed.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @polygonlabs/agentconnect-ui typecheck
git add packages/agentconnect-ui/src/login/machine.ts packages/agentconnect-ui/src/login/machine.test.ts packages/agentconnect-ui/package.json pnpm-lock.yaml
git commit -m "feat(agentconnect-ui): login page state machine"
```

---

### Task 7: LoginPage component, route, and config

**Files:**
- Create: `packages/agentconnect-ui/src/login/LoginPage.tsx`
- Modify: `packages/agentconnect-ui/src/App.tsx` (route on `/login`, export `LogoBadge`)
- Modify: `packages/agentconnect-ui/src/config.ts` (relay URL)
- Modify: `packages/agentconnect-ui/.env.example` (document `VITE_OIDC_RELAY_URL`)

**Interfaces:**
- Consumes: `reduce`/`initialState`/types from Task 6; relay routes from Task 2; `LogoBadge` from `App.tsx`.
- Produces: `LoginPage` component rendered when `window.location.pathname === '/login'`.

- [ ] **Step 1: Add the relay URL to config**

In `packages/agentconnect-ui/src/config.ts`, append:

```ts
// oidc-relay base URL for the /login pairing session (per-environment secret).
export const oidcRelayUrl =
  (import.meta.env.VITE_OIDC_RELAY_URL as string | undefined) ??
  'https://oidc-relay.polygon.technology';
```

Add to `packages/agentconnect-ui/.env.example`:

```
VITE_OIDC_RELAY_URL=https://oidc-relay.polygon.technology
```

- [ ] **Step 2: Export `LogoBadge` from App.tsx**

In `packages/agentconnect-ui/src/App.tsx`, find the `LogoBadge` function component and add `export` to its declaration (`function LogoBadge` becomes `export function LogoBadge`), leaving its body unchanged.

- [ ] **Step 3: Create the LoginPage component**

Create `packages/agentconnect-ui/src/login/LoginPage.tsx`. Follow the existing visual language of App.tsx: `#f5f6fb` page background, `#141635` primary, white cards with `rounded-2xl` and the same shadow treatment, `LogoBadge` fixed top-center. All copy in sentence case, no em dashes.

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';

import { LogoBadge } from '../App.js';
import { oidcRelayUrl } from '../config';
import {
  initialState,
  reduce,
  type MachineEvent,
  type MachineState,
  type RelayStatus
} from './machine.js';

const WALLET_URL = 'https://wallet.polygon.technology';
const POLL_MS = 1500;

type LoginAction =
  | { type: 'google' }
  | { type: 'email'; email: string }
  | { type: 'otp'; code: string }
  | { type: 'cancel' };

async function postAction(session: string, action: LoginAction): Promise<void> {
  await fetch(`${oidcRelayUrl}/api/login/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session, action })
  });
}

async function fetchStatus(session: string): Promise<RelayStatus> {
  const res = await fetch(`${oidcRelayUrl}/api/login/status?session=${encodeURIComponent(session)}`);
  if (!res.ok) return { status: 'expired' };
  return (await res.json()) as RelayStatus;
}

const TERMINAL: MachineState['kind'][] = ['success', 'expired', 'failed'];

export function LoginPage() {
  const session = window.location.hash.slice(1);
  const [state, setState] = useState<MachineState>(initialState);
  const dispatch = useCallback((event: MachineEvent) => {
    setState((s) => reduce(s, event));
  }, []);
  const redirected = useRef(false);

  // Poll the relay for CLI-published status; redirect once when the auth url
  // arrives (a side effect the reducer deliberately does not model).
  useEffect(() => {
    if (!session || TERMINAL.includes(state.kind)) return;
    const timer = setInterval(() => {
      void fetchStatus(session).then((status) => {
        if (status.status === 'auth-url' && !redirected.current && state.kind === 'google-wait') {
          redirected.current = true;
          window.location.assign(status.url);
          return;
        }
        dispatch({ type: 'status', status });
      });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [session, state.kind, dispatch]);

  if (!session) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold text-[#141635]">No login session</h1>
        <p className="mt-2 text-sm text-[#64708f]">
          Open this page from the polygon-agent CLI: run
          <code className="mx-1 rounded bg-[#eef0f8] px-1.5 py-0.5 text-xs">polygon-agent wallet login</code>
          in your terminal.
        </p>
      </Shell>
    );
  }

  return <Shell>{renderState(state, session, dispatch)}</Shell>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#f5f6fb] flex flex-col items-center justify-center px-4">
      <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[99999]">
        <LogoBadge />
      </div>
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-[0_2px_8px_rgba(20,22,53,0.06)] border border-[#e3e7f2]">
        {children}
      </div>
    </div>
  );
}

function renderState(
  state: MachineState,
  session: string,
  dispatch: (e: MachineEvent) => void
) {
  switch (state.kind) {
    case 'method':
      return (
        <MethodChoice
          onGoogle={() => {
            void postAction(session, { type: 'google' });
            dispatch({ type: 'choose-google' });
          }}
          onEmail={() => dispatch({ type: 'choose-email' })}
          onCancel={() => {
            // The CLI consumes the cancel, publishes an error status, and exits;
            // the next poll moves this page to the failed state.
            void postAction(session, { type: 'cancel' });
          }}
        />
      );
    case 'google-wait':
      return <Waiting text="Sending you to Google sign in" />;
    case 'email-entry':
      return (
        <EmailForm
          onSubmit={(email) => {
            void postAction(session, { type: 'email', email });
            dispatch({ type: 'submit-email', email });
          }}
          onBack={() => dispatch({ type: 'back' })}
        />
      );
    case 'email-wait':
      return <Waiting text="Sending a sign in code to your inbox" />;
    case 'otp-entry':
      return (
        <OtpForm
          invalid={state.invalid}
          attemptsLeft={state.attemptsLeft}
          onSubmit={(code) => {
            void postAction(session, { type: 'otp', code });
            dispatch({ type: 'submit-otp', code });
          }}
        />
      );
    case 'otp-wait':
      return <Waiting text="Checking your code" />;
    case 'success':
      return (
        <div className="text-center">
          <h1 className="text-xl font-semibold text-[#141635]">You're signed in</h1>
          <p className="mt-2 text-sm text-[#64708f] break-all">Wallet {state.walletAddress}</p>
          <p className="mt-2 text-sm text-[#64708f]">
            Your terminal session is ready. You can close this tab.
          </p>
          <a
            href={WALLET_URL}
            className="mt-6 inline-block rounded-xl bg-[#141635] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#1e2155]"
          >
            Manage your wallet
          </a>
        </div>
      );
    case 'expired':
      return (
        <div className="text-center">
          <h1 className="text-xl font-semibold text-[#141635]">This link has expired</h1>
          <p className="mt-2 text-sm text-[#64708f]">
            Run <code className="rounded bg-[#eef0f8] px-1.5 py-0.5 text-xs">polygon-agent wallet login</code> again
            to get a fresh link.
          </p>
        </div>
      );
    case 'failed':
      return (
        <div className="text-center">
          <h1 className="text-xl font-semibold text-[#141635]">Sign in failed</h1>
          <p className="mt-2 text-sm text-[#64708f]">{state.message}</p>
          <p className="mt-2 text-sm text-[#64708f]">Check your terminal for details and re-run the login.</p>
        </div>
      );
  }
}

function MethodChoice({
  onGoogle,
  onEmail,
  onCancel
}: {
  onGoogle: () => void;
  onEmail: () => void;
  onCancel: () => void;
}) {
  return (
    <div>
      <h1 className="text-xl font-semibold text-[#141635] text-center">Sign in to your agent wallet</h1>
      <p className="mt-2 text-sm text-[#64708f] text-center">
        This connects the polygon-agent CLI in your terminal.
      </p>
      <button
        onClick={onGoogle}
        className="mt-6 w-full rounded-xl bg-[#141635] px-5 py-3 text-sm font-medium text-white hover:bg-[#1e2155]"
      >
        Continue with Google
      </button>
      <button
        onClick={onEmail}
        className="mt-3 w-full rounded-xl border border-[#c8cfe1] px-5 py-3 text-sm font-medium text-[#141635] hover:bg-[#f5f6fb]"
      >
        Continue with email
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="mt-3 w-full text-sm text-[#64708f] hover:text-[#141635]"
      >
        Cancel this login
      </button>
    </div>
  );
}

function EmailForm({ onSubmit, onBack }: { onSubmit: (email: string) => void; onBack: () => void }) {
  const [email, setEmail] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (email.includes('@')) onSubmit(email.trim());
      }}
    >
      <h1 className="text-xl font-semibold text-[#141635] text-center">Sign in with email</h1>
      <input
        type="email"
        required
        autoFocus
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        className="mt-6 w-full rounded-xl border border-[#c8cfe1] px-4 py-3 text-sm text-[#141635] outline-none focus:border-[#141635]"
      />
      <button
        type="submit"
        className="mt-4 w-full rounded-xl bg-[#141635] px-5 py-3 text-sm font-medium text-white hover:bg-[#1e2155]"
      >
        Send code
      </button>
      <button
        type="button"
        onClick={onBack}
        className="mt-3 w-full text-sm text-[#64708f] hover:text-[#141635]"
      >
        Back
      </button>
    </form>
  );
}

function OtpForm({
  invalid,
  attemptsLeft,
  onSubmit
}: {
  invalid?: boolean;
  attemptsLeft?: number;
  onSubmit: (code: string) => void;
}) {
  const [code, setCode] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (code.trim().length >= 4) onSubmit(code.trim());
      }}
    >
      <h1 className="text-xl font-semibold text-[#141635] text-center">Enter your code</h1>
      <p className="mt-2 text-sm text-[#64708f] text-center">We sent a one-time code to your email.</p>
      {invalid && (
        <p className="mt-2 text-sm text-[#d92d20] text-center">
          That code didn't work{typeof attemptsLeft === 'number' ? ` (${attemptsLeft} attempts left)` : ''}. Try again.
        </p>
      )}
      <input
        inputMode="numeric"
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="123456"
        className="mt-6 w-full rounded-xl border border-[#c8cfe1] px-4 py-3 text-center text-lg tracking-[0.3em] text-[#141635] outline-none focus:border-[#141635]"
      />
      <button
        type="submit"
        className="mt-4 w-full rounded-xl bg-[#141635] px-5 py-3 text-sm font-medium text-white hover:bg-[#1e2155]"
      >
        Verify
      </button>
    </form>
  );
}

function Waiting({ text }: { text: string }) {
  return (
    <div className="text-center">
      <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-[#c8cfe1] border-t-[#141635]" />
      <p className="mt-4 text-sm text-[#64708f]">{text}</p>
    </div>
  );
}
```

`LogoBadge` takes no props (it renders the Polygon logo plus the `>_ agent` chip at `App.tsx:169`); the import works once Step 2's `export` keyword is added.

- [ ] **Step 4: Route `/login` in App.tsx**

In `packages/agentconnect-ui/src/App.tsx`, add the import:

```tsx
import { LoginPage } from './login/LoginPage.js';
```

and at the top of the `App` function body (before the `params` memo):

```tsx
  if (window.location.pathname === '/login') {
    return <LoginPage />;
  }
```

- [ ] **Step 5: Typecheck, lint, and verify in the browser**

```bash
pnpm --filter @polygonlabs/agentconnect-ui typecheck && pnpm --filter @polygonlabs/agentconnect-ui lint
```

Manual verification against the local relay:

```bash
cd packages/oidc-relay && npx -y wrangler@3 dev --port 8788 &
cd ../agentconnect-ui && VITE_OIDC_RELAY_URL=http://localhost:8788 pnpm dev &
sleep 8
# Register a session like the CLI would:
curl -s -X POST localhost:8788/api/login/register -H 'content-type: application/json' -d '{"session":"uitest1234567890"}' -o /dev/null
```

Open `http://localhost:5173/login#uitest1234567890`:
- Method choice renders with both buttons.
- Click "Continue with email", submit an address, page shows the waiting spinner.
- Simulate the CLI: `curl -s -X POST localhost:8788/api/login/status -H 'content-type: application/json' -d '{"session":"uitest1234567890","status":{"status":"otp-sent"}}'` and the OTP input appears.
- Simulate completion: `curl -s -X POST localhost:8788/api/login/status -H 'content-type: application/json' -d '{"session":"uitest1234567890","status":{"status":"done","walletAddress":"0xabc"}}'` and the success screen appears with the wallet.polygon.technology button.
- `http://localhost:5173/login` (no hash) shows the "No login session" notice.
- Fresh session + "Cancel this login": `curl -s "localhost:8788/api/login/next-action?session=<id>"` returns the cancel action (this is what the CLI consumes).
- `http://localhost:5173/?wallet=0xabc` still renders the dashboard (route untouched).

Kill both dev servers when done.

- [ ] **Step 6: Commit**

```bash
git add packages/agentconnect-ui/src/login/LoginPage.tsx packages/agentconnect-ui/src/App.tsx packages/agentconnect-ui/src/config.ts packages/agentconnect-ui/.env.example
git commit -m "feat(agentconnect-ui): /login page for the browser login flow"
```

---

### Task 8: Staging end-to-end and production checklist

**Files:**
- No new source files; deploys and verification. Possible small fixes discovered here get their own commits.

**Interfaces:**
- Consumes: everything above.
- Produces: verified staging flow; a ticked production checklist.

- [ ] **Step 1: Deploy the relay and UI to staging**

```bash
pnpm --filter @polygonlabs/oidc-relay deploy:staging
pnpm --filter @polygonlabs/agentconnect-ui deploy:staging
```

Note the staging relay URL (workers.dev) from the wrangler output. The staging UI build must have `VITE_OIDC_RELAY_URL` set to it (GitHub Environments secret, or build locally with the env var before deploying).

- [ ] **Step 2: End-to-end Google login (human in the loop)**

```bash
POLYGON_AGENT_OIDC_RELAY=https://oidc-relay-staging.<account>.workers.dev \
POLYGON_AGENT_LOGIN_UI=https://agentconnect.staging.polygon.technology \
  tsx packages/polygon-agent-cli/src/index.ts wallet login --name e2e-google --force --no-fund
```

Verify: the printed URL opens the branded page; Continue with Google round-trips through Google and lands back on the page; page shows the success state with the wallet address and the wallet.polygon.technology button; the CLI prints `{"ok":true,...,"loginMethod":"google"}`.

- [ ] **Step 3: End-to-end email login (human in the loop)**

Same command with `--name e2e-email`. On the page choose email, enter a real inbox, type the received code. Verify one deliberate wrong code first: the page shows the invalid-code message with attempts left, then the right code succeeds and the CLI prints `loginMethod":"email"`.

- [ ] **Step 4: Regression-check the fallback and expiry**

- `wallet login --local --name e2e-local --no-fund`: old loopback flow works unchanged.
- Start a login, wait 10+ minutes without touching the page, confirm the CLI times out cleanly and the page shows the expired state on next poll.
- Clean up test wallets: `wallet remove --name e2e-google` etc.

- [ ] **Step 5: Production checklist (record ticks in the PR description)**

- [ ] Enable the relay production custom domain in `packages/oidc-relay/wrangler.toml` (uncomment/set `routes`, e.g. `oidc-relay.polygon.technology`) and deploy.
- [ ] Ask Sequence to allowlist `https://oidc-relay.polygon.technology/api/oidc/cb` as a redirect target (same process as the staging/localhost adds).
- [ ] Confirm the CLI defaults in `oms-client.ts` match the deployed domains.
- [ ] Set `VITE_OIDC_RELAY_URL` in the production GitHub Environment and deploy agentconnect production.
- [ ] Full production smoke: one Google login, one email login, from a machine that is not the deploy machine.

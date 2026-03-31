import { MAX_CODE_ATTEMPTS, REQUEST_TTL_SECONDS } from '@polygonlabs/agent-shared';

/**
 * Relay module for v2 session handoff.
 *
 * Two exports:
 *  - `SessionRelay` — Cloudflare Durable Object that stores the encrypted session
 *    payload for one 5-minute window. Internal-only; accessed via `SESSION_RELAY` binding.
 *  - `handleRelayRequest` — Route dispatcher called from the main Worker for all
 *    `/api/relay/*` requests from browsers and the CLI.
 */

// --- Validation helpers ---

function isHex(s: unknown, len: number): s is string {
  return typeof s === 'string' && s.length === len && /^[0-9a-f]+$/.test(s);
}

function isB64url(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && /^[A-Za-z0-9_-]+$/.test(s);
}

/** Constant-time hex string comparison (avoids timing attacks). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function cors(response: Response): Response {
  const h = new Headers(response.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(response.body, { status: response.status, headers: h });
}

function json(data: unknown, status = 200): Response {
  return cors(Response.json(data, { status }));
}

function err(msg: string, status: number): Response {
  return cors(
    new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

// --- Durable Object ---

export class SessionRelay {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { method } = request;

    if (method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    if (method === 'POST' && url.pathname === '/init') return this.handleInit(request);
    if (method === 'GET' && url.pathname === '/public-key') return this.handleGetPublicKey();
    if (method === 'POST' && url.pathname === '/session') return this.handlePostSession(request);
    if (method === 'GET' && url.pathname === '/status') return this.handleGetStatus();
    if (method === 'POST' && url.pathname === '/retrieve') return this.handleRetrieve(request);

    return err('Not found', 404);
  }

  private async handleInit(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err('Invalid JSON', 400);
    }
    const { cli_pk_hex } = body as Record<string, unknown>;
    if (!isHex(cli_pk_hex, 64)) return err('cli_pk_hex must be 64 hex chars', 400);

    const existing = await this.state.storage.get<string>('status');
    if (existing) return err('Already initialized', 409);

    await this.state.storage.put('cli_pk_hex', cli_pk_hex);
    await this.state.storage.put('status', 'pending');
    await this.state.storage.put('attempts_remaining', MAX_CODE_ATTEMPTS);
    await this.state.storage.setAlarm(Date.now() + REQUEST_TTL_SECONDS * 1000);

    return cors(new Response(null, { status: 204 }));
  }

  private async handleGetPublicKey(): Promise<Response> {
    const cli_pk_hex = await this.state.storage.get<string>('cli_pk_hex');
    if (!cli_pk_hex) return err('Not found', 404);
    return json({ cli_pk_hex });
  }

  private async handlePostSession(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err('Invalid JSON', 400);
    }
    const { wallet_pk_hex, nonce_hex, ciphertext_b64url, code_hash_hex } = body as Record<
      string,
      unknown
    >;

    if (!isHex(wallet_pk_hex, 64)) return err('wallet_pk_hex must be 64 hex chars', 400);
    if (!isHex(nonce_hex, 48)) return err('nonce_hex must be 48 hex chars', 400);
    if (!isB64url(ciphertext_b64url)) return err('ciphertext_b64url must be base64url', 400);
    if (!isHex(code_hash_hex, 64)) return err('code_hash_hex must be 64 hex chars', 400);

    const status = await this.state.storage.get<string>('status');
    if (status !== 'pending') return err('Request not in pending state', 409);

    await this.state.storage.put('wallet_pk_hex', wallet_pk_hex);
    await this.state.storage.put('nonce_hex', nonce_hex);
    await this.state.storage.put('ciphertext_b64url', ciphertext_b64url);
    await this.state.storage.put('code_hash_hex', code_hash_hex);
    await this.state.storage.put('status', 'ready');

    return cors(new Response(null, { status: 204 }));
  }

  private async handleGetStatus(): Promise<Response> {
    const status = await this.state.storage.get<string>('status');
    if (!status) return err('Not found', 404);
    return json({ status });
  }

  private async handleRetrieve(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err('Invalid JSON', 400);
    }
    const { code_hash_hex } = body as Record<string, unknown>;
    if (!isHex(code_hash_hex, 64)) return err('code_hash_hex must be 64 hex chars', 400);

    const stored = await this.state.storage.get<string>('code_hash_hex');
    const attempts = (await this.state.storage.get<number>('attempts_remaining')) ?? 0;

    if (!stored) return err('Not found', 404);
    if (attempts <= 0) {
      await this.state.storage.deleteAll();
      return err('Expired', 410);
    }

    if (!constantTimeEqual(code_hash_hex, stored)) {
      const remaining = attempts - 1;
      await this.state.storage.put('attempts_remaining', remaining);
      if (remaining <= 0) {
        await this.state.storage.deleteAll();
        return err('Expired', 410);
      }
      return json({ attempts_remaining: remaining }, 403);
    }

    // Correct code — retrieve and delete everything
    const [wallet_pk_hex, nonce_hex, ciphertext_b64url] = await Promise.all([
      this.state.storage.get<string>('wallet_pk_hex'),
      this.state.storage.get<string>('nonce_hex'),
      this.state.storage.get<string>('ciphertext_b64url')
    ]);
    await this.state.storage.deleteAll();

    return json({ wallet_pk_hex, nonce_hex, ciphertext_b64url, code_hash_hex: stored });
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}

// --- Relay route handler (called from main Worker) ---

export async function handleRelayRequest(
  request: Request,
  env: { SESSION_RELAY: DurableObjectNamespace }
): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return cors(
      new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      })
    );
  }

  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  // Expected: ['api', 'relay', <action>, <rid?>]

  if (parts[0] !== 'api' || parts[1] !== 'relay') return err('Not found', 404);

  const action = parts[2];
  const rid = parts[3];

  // POST /api/relay/request  → create new relay request
  if (request.method === 'POST' && action === 'request' && !rid) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err('Invalid JSON', 400);
    }
    const { cli_pk_hex } = body as Record<string, unknown>;
    if (!isHex(cli_pk_hex, 64)) return err('cli_pk_hex must be 64 hex chars', 400);

    // Generate a random 8-char alphanumeric request ID
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const request_id = Array.from(bytes)
      .map((b) => alphabet[b % alphabet.length])
      .join('');

    const stub = env.SESSION_RELAY.get(env.SESSION_RELAY.idFromName(request_id));
    const initRes = await stub.fetch(
      new Request('https://do/init', {
        method: 'POST',
        body: JSON.stringify({ cli_pk_hex }),
        headers: { 'Content-Type': 'application/json' }
      })
    );
    if (!initRes.ok) return err('Failed to initialize relay session', 500);

    return json({ request_id });
  }

  if (!rid) return err('Missing request ID', 400);
  if (!/^[a-z0-9]{8}$/.test(rid)) return err('Invalid request ID', 400);

  const stub = env.SESSION_RELAY.get(env.SESSION_RELAY.idFromName(rid));

  // GET /api/relay/request/:rid  → get CLI public key
  if (request.method === 'GET' && action === 'request') {
    const res = await stub.fetch(new Request('https://do/public-key'));
    if (!res.ok) return err('Not found', 404);
    return cors(res);
  }

  // POST /api/relay/session/:rid  → browser posts encrypted payload
  if (request.method === 'POST' && action === 'session') {
    const body = await request.text();
    if (body.length > 16384) return err('Payload too large', 413);
    const res = await stub.fetch(
      new Request('https://do/session', {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/json' }
      })
    );
    return cors(res);
  }

  // GET /api/relay/status/:rid  → poll for "pending" | "ready"
  if (request.method === 'GET' && action === 'status') {
    const res = await stub.fetch(new Request('https://do/status'));
    if (!res.ok) return err('Not found', 404);
    return cors(res);
  }

  // POST /api/relay/retrieve/:rid  → CLI submits code hash, gets ciphertext
  if (request.method === 'POST' && action === 'retrieve') {
    const body = await request.text();
    const res = await stub.fetch(
      new Request('https://do/retrieve', {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/json' }
      })
    );
    return cors(res);
  }

  return err('Not found', 404);
}

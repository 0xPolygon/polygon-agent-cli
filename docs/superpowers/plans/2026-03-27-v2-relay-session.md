# Polygon Agent Kit v2 — Relay Session Handoff

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cloudflared-tunnel session handoff with a Cloudflare Durable Object relay + 6-digit out-of-band code, keeping all existing CLI/UI styles and adding only the necessary new screens.

**Architecture:** A new `packages/shared` workspace package provides the pure-JS crypto protocol (X25519 ECDH + HKDF-SHA256 + XChaCha20-Poly1305) usable in both Node.js and Cloudflare Workers. The existing `connector-ui` Worker gains a `/api/relay/*` API backed by a `SessionRelay` Durable Object; the SPA adds a code-display screen. The CLI replaces its cloudflared + local HTTP server with a relay HTTP client + readline code prompt.

**Tech Stack:** `@noble/curves` (X25519), `@noble/hashes` (HKDF/SHA-256), `@noble/ciphers` (XChaCha20-Poly1305), Cloudflare Durable Objects, pnpm workspaces, Vite + React + Tailwind (connector-ui), yargs (CLI).

**Branch:** `feat/v2-relay-session`

---

## File Map

### New
| File | Responsibility |
|------|---------------|
| `packages/shared/package.json` | Workspace package declaration, @noble/* deps |
| `packages/shared/src/constants.ts` | Protocol constants (TTL, code length, max attempts) |
| `packages/shared/src/types.ts` | `SessionPayload`, `EncryptedPayload`, relay request/response shapes |
| `packages/shared/src/encoding.ts` | Hex ↔ bytes, base64url ↔ bytes helpers |
| `packages/shared/src/crypto.ts` | X25519 keypair gen, encrypt, decrypt |
| `packages/shared/src/index.ts` | Re-exports |
| `packages/shared/crypto.test.ts` | Round-trip encrypt/decrypt test |
| `packages/shared/vitest.config.ts` | Vitest config |
| `packages/connector-ui/src/relay.ts` | `SessionRelay` Durable Object + relay route handlers |
| `packages/connector-ui/src/components/CodeDisplay.tsx` | "Enter this code" screen (existing Tailwind style) |
| `packages/polygon-agent-cli/src/lib/relay-client.ts` | HTTP client to relay (createRequest, getStatus, retrieve) |

### Modified
| File | What changes |
|------|-------------|
| `packages/connector-ui/worker.mjs` | Route `/api/relay/*` to DO; export `SessionRelay` |
| `packages/connector-ui/wrangler.toml` | Add `[durable_objects]` binding + migration |
| `packages/connector-ui/package.json` | Add `@polygonlabs/agent-shared` workspace dep |
| `packages/connector-ui/src/App.tsx` | New state machine; replace sealed-box with shared crypto; add code-display screen |
| `packages/connector-ui/src/config.ts` | Add `relayUrl` export |
| `packages/polygon-agent-cli/src/commands/wallet.ts` | Replace tunnel/local-server with relay-client + readline prompt |
| `packages/polygon-agent-cli/package.json` | Add `@polygonlabs/agent-shared`, `@noble/*` deps; remove `tweetnacl` |
| `pnpm-workspace.yaml` | Already covers `packages/*`; no change needed |

---

## Task 1: packages/shared — crypto protocol package

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/src/constants.ts`
- Create: `packages/shared/src/types.ts`
- Create: `packages/shared/src/encoding.ts`
- Create: `packages/shared/src/crypto.ts`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/crypto.test.ts`
- Create: `packages/shared/vitest.config.ts`

- [ ] **Step 1: Create package.json**

```json
// packages/shared/package.json
{
  "name": "@polygonlabs/agent-shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run"
  },
  "dependencies": {
    "@noble/ciphers": "^1.2.1",
    "@noble/curves": "^1.8.1",
    "@noble/hashes": "^1.7.2"
  },
  "devDependencies": {
    "vitest": "^3.1.1"
  }
}
```

- [ ] **Step 2: Create constants.ts**

```typescript
// packages/shared/src/constants.ts
export const PROTOCOL_VERSION = 'polygon-agent-session-v1';
export const CODE_LENGTH = 6;
export const MAX_CODE_ATTEMPTS = 3;
export const REQUEST_TTL_SECONDS = 300;
export const REQUEST_ID_LENGTH = 8;
```

- [ ] **Step 3: Create types.ts**

```typescript
// packages/shared/src/types.ts

export interface ImplicitSession {
  pk: string;
  attestation: string;
  identity_sig: string;
}

export interface SessionPermissions {
  /** Max native token spend, as wei string */
  native_limit?: string;
  erc20_limits?: Array<{ token_address: string; limit: string }>;
  contract_calls?: Array<{ address: string; functions: string[] }>;
}

export interface SessionPayload {
  version: 1;
  wallet_address: string;
  chain_id: number;
  /** Hex-encoded explicit session private key */
  session_private_key: string;
  /** Explicit session signer address */
  session_address: string;
  permissions: SessionPermissions;
  /** Unix timestamp — expiry of explicit session */
  expiry: number;
  ecosystem_wallet_url: string;
  dapp_origin: string;
  project_access_key: string;
  relayer_url?: string;
  /** Full explicit session config, JSON-stringified (for dapp-client reconstruction) */
  session_config?: string;
  implicit_session?: ImplicitSession;
}

export interface EncryptedPayload {
  wallet_pk_hex: string;
  nonce_hex: string;
  ciphertext_b64url: string;
  code_hash_hex: string;
}

export interface RelayCreateResponse {
  request_id: string;
}

export interface RelayStatusResponse {
  status: 'pending' | 'ready';
}
```

- [ ] **Step 4: Create encoding.ts**

```typescript
// packages/shared/src/encoding.ts

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function b64urlEncode(bytes: Uint8Array): string {
  // Works in Node.js and Cloudflare Workers
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str: string): Uint8Array {
  const norm = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4));
  const bin = atob(norm + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
```

- [ ] **Step 5: Create crypto.ts**

```typescript
// packages/shared/src/crypto.ts
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { randomBytes } from '@noble/hashes/utils';
import { PROTOCOL_VERSION, CODE_LENGTH } from './constants.js';
import { bytesToHex, hexToBytes, b64urlEncode, b64urlDecode } from './encoding.js';
import type { EncryptedPayload, SessionPayload } from './types.js';

export interface X25519Keypair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export function generateX25519Keypair(): X25519Keypair {
  const secretKey = randomBytes(32);
  const publicKey = x25519.getPublicKey(secretKey);
  return { secretKey, publicKey };
}

/** Generates a random 6-digit code string, zero-padded. */
export function generateCode(): string {
  // Use 4 random bytes, take mod 1_000_000 to get 0–999999
  const bytes = randomBytes(4);
  const n = new DataView(bytes.buffer).getUint32(0) % 1_000_000;
  return n.toString().padStart(CODE_LENGTH, '0');
}

/** SHA-256(requestId + code). Used as the code_hash sent to the relay. */
export function computeCodeHash(requestId: string, code: string): Uint8Array {
  return sha256(new TextEncoder().encode(requestId + code));
}

function deriveEncKey(
  shared: Uint8Array,
  code: string,
  cliPkHex: string,
  walletPkHex: string
): Uint8Array {
  const salt = sha256(new TextEncoder().encode(code));
  const info = new TextEncoder().encode(cliPkHex + walletPkHex + PROTOCOL_VERSION);
  return hkdf(sha256, shared, salt, info, 32);
}

/**
 * Encrypt a SessionPayload for the CLI to decrypt.
 * Returns the EncryptedPayload (to POST to relay) and the plaintext code (to display to user).
 */
export function encryptSession(
  payload: SessionPayload,
  cliPkHex: string,
  requestId: string
): { encrypted: EncryptedPayload; code: string } {
  const cliPk = hexToBytes(cliPkHex);
  const { secretKey: walletSk, publicKey: walletPk } = generateX25519Keypair();
  const shared = x25519.getSharedSecret(walletSk, cliPk);

  const walletPkHex = bytesToHex(walletPk);
  const code = generateCode();
  const encKey = deriveEncKey(shared, code, cliPkHex, walletPkHex);

  const nonce = randomBytes(24);
  const aad = new Uint8Array([...cliPk, ...walletPk]);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));

  const cipher = xchacha20poly1305(encKey, nonce, aad);
  const ciphertext = cipher.encrypt(plaintext);

  const encrypted: EncryptedPayload = {
    wallet_pk_hex: walletPkHex,
    nonce_hex: bytesToHex(nonce),
    ciphertext_b64url: b64urlEncode(ciphertext),
    code_hash_hex: bytesToHex(computeCodeHash(requestId, code))
  };

  return { encrypted, code };
}

/**
 * Decrypt a session payload received from the relay.
 * The code is provided by the user out-of-band.
 */
export function decryptSession(
  encrypted: EncryptedPayload,
  cliSk: Uint8Array,
  code: string,
  requestId: string
): SessionPayload {
  const cliPk = x25519.getPublicKey(cliSk);
  const walletPk = hexToBytes(encrypted.wallet_pk_hex);
  const shared = x25519.getSharedSecret(cliSk, walletPk);

  const cliPkHex = bytesToHex(cliPk);
  const walletPkHex = encrypted.wallet_pk_hex;
  const encKey = deriveEncKey(shared, code, cliPkHex, walletPkHex);

  const nonce = hexToBytes(encrypted.nonce_hex);
  const aad = new Uint8Array([...cliPk, ...walletPk]);
  const ciphertext = b64urlDecode(encrypted.ciphertext_b64url);

  const cipher = xchacha20poly1305(encKey, nonce, aad);
  // xchacha20poly1305.decrypt throws if auth tag fails
  const plaintext = cipher.decrypt(ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext)) as SessionPayload;
}
```

- [ ] **Step 6: Create index.ts**

```typescript
// packages/shared/src/index.ts
export * from './constants.js';
export * from './types.js';
export * from './encoding.js';
export * from './crypto.js';
```

- [ ] **Step 7: Write failing test**

```typescript
// packages/shared/crypto.test.ts
import { describe, it, expect } from 'vitest';
import {
  generateX25519Keypair,
  encryptSession,
  decryptSession,
  generateCode,
  computeCodeHash
} from './src/crypto.js';
import { bytesToHex } from './src/encoding.js';
import type { SessionPayload } from './src/types.js';

const SAMPLE_PAYLOAD: SessionPayload = {
  version: 1,
  wallet_address: '0xc448e20a23d9ca5b0f9d667c6676f64c73cff8b7',
  chain_id: 137,
  session_private_key: '0x' + 'ab'.repeat(32),
  session_address: '0x' + 'cd'.repeat(20),
  permissions: { native_limit: '2000000000000000000', erc20_limits: [] },
  expiry: Math.floor(Date.now() / 1000) + 86400 * 183,
  ecosystem_wallet_url: 'https://wallet.sequence.app',
  dapp_origin: 'https://agentconnect.polygon.technology',
  project_access_key: 'AQAAAAAAAAAAAAAAAAAAAAAAAAAtest'
};

describe('session encrypt/decrypt round-trip', () => {
  it('decrypts to original payload', () => {
    const { secretKey: cliSk, publicKey: cliPk } = generateX25519Keypair();
    const requestId = 'abc12345';
    const cliPkHex = bytesToHex(cliPk);

    const { encrypted, code } = encryptSession(SAMPLE_PAYLOAD, cliPkHex, requestId);

    expect(code).toMatch(/^\d{6}$/);
    expect(encrypted.wallet_pk_hex).toHaveLength(64);
    expect(encrypted.nonce_hex).toHaveLength(48);

    const decrypted = decryptSession(encrypted, cliSk, code, requestId);
    expect(decrypted.wallet_address).toBe(SAMPLE_PAYLOAD.wallet_address);
    expect(decrypted.chain_id).toBe(137);
    expect(decrypted.session_private_key).toBe(SAMPLE_PAYLOAD.session_private_key);
  });

  it('throws on wrong code', () => {
    const { secretKey: cliSk, publicKey: cliPk } = generateX25519Keypair();
    const requestId = 'abc12345';
    const { encrypted } = encryptSession(SAMPLE_PAYLOAD, bytesToHex(cliPk), requestId);
    expect(() => decryptSession(encrypted, cliSk, '000000', requestId)).toThrow();
  });

  it('generates 6-digit codes', () => {
    for (let i = 0; i < 20; i++) {
      const code = generateCode();
      expect(code).toMatch(/^\d{6}$/);
      expect(parseInt(code)).toBeGreaterThanOrEqual(0);
      expect(parseInt(code)).toBeLessThan(1_000_000);
    }
  });

  it('computeCodeHash is deterministic', () => {
    const h1 = computeCodeHash('req123', '847291');
    const h2 = computeCodeHash('req123', '847291');
    expect(bytesToHex(h1)).toBe(bytesToHex(h2));
  });
});
```

- [ ] **Step 8: Create vitest.config.ts**

```typescript
// packages/shared/vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node' }
});
```

- [ ] **Step 9: Install deps and run test (expect FAIL — package not yet built)**

```bash
cd /path/to/polygon-agent-kit
pnpm install
cd packages/shared && pnpm test
```

Expected: FAIL — `Cannot find module '@noble/curves/ed25519'` or similar (deps not installed yet). If `pnpm install` ran, it should FAIL with test errors, not module-not-found errors.

After `pnpm install`, run again:

```bash
pnpm test
```

Expected: All 4 tests PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add v2 crypto protocol package (X25519+HKDF+XChaCha20)"
```

---

## Task 2: connector-ui — Durable Object relay API

**Files:**
- Create: `packages/connector-ui/src/relay.ts`
- Modify: `packages/connector-ui/worker.mjs`
- Modify: `packages/connector-ui/wrangler.toml`

The relay runs inside the same Worker that serves the SPA. Requests to `/api/relay/*` are forwarded to `SessionRelay` Durable Objects (one per request ID). All other paths serve the SPA as before.

- [ ] **Step 1: Create src/relay.ts (Durable Object + route handlers)**

```typescript
// packages/connector-ui/src/relay.ts
import { MAX_CODE_ATTEMPTS, REQUEST_TTL_SECONDS } from '@polygonlabs/agent-shared';

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
  return cors(new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  }));
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
    try { body = await request.json(); } catch { return err('Invalid JSON', 400); }
    const { cli_pk_hex } = body as Record<string, unknown>;
    if (!isHex(cli_pk_hex, 64)) return err('cli_pk_hex must be 64 hex chars', 400);

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
    try { body = await request.json(); } catch { return err('Invalid JSON', 400); }
    const { wallet_pk_hex, nonce_hex, ciphertext_b64url, code_hash_hex } = body as Record<string, unknown>;

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
    try { body = await request.json(); } catch { return err('Invalid JSON', 400); }
    const { code_hash_hex } = body as Record<string, unknown>;
    if (!isHex(code_hash_hex, 64)) return err('code_hash_hex must be 64 hex chars', 400);

    const stored = await this.state.storage.get<string>('code_hash_hex');
    const attempts = await this.state.storage.get<number>('attempts_remaining') ?? 0;

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

    return json({ wallet_pk_hex, nonce_hex, ciphertext_b64url });
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
    return cors(new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    }));
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
    try { body = await request.json(); } catch { return err('Invalid JSON', 400); }
    const { cli_pk_hex } = body as Record<string, unknown>;
    if (!isHex(cli_pk_hex, 64)) return err('cli_pk_hex must be 64 hex chars', 400);

    // Generate a random 8-char alphanumeric request ID
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const request_id = Array.from(bytes).map(b => alphabet[b % alphabet.length]).join('');

    const stub = env.SESSION_RELAY.get(env.SESSION_RELAY.idFromName(request_id));
    await stub.fetch(new Request('https://do/init', {
      method: 'POST',
      body: JSON.stringify({ cli_pk_hex }),
      headers: { 'Content-Type': 'application/json' }
    }));

    return json({ request_id });
  }

  if (!rid) return err('Missing request ID', 400);

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
    const res = await stub.fetch(new Request('https://do/session', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' }
    }));
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
    const res = await stub.fetch(new Request('https://do/retrieve', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' }
    }));
    return cors(res);
  }

  return err('Not found', 404);
}
```

- [ ] **Step 2: Update worker.mjs to route relay requests**

Replace the entire contents of `packages/connector-ui/worker.mjs`:

```javascript
// packages/connector-ui/worker.mjs
import { handleRelayRequest, SessionRelay } from './src/relay.ts';

export { SessionRelay };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Route /api/relay/* to Durable Object relay
    if (url.pathname.startsWith('/api/relay')) {
      return handleRelayRequest(request, env);
    }

    if (!env.ASSETS) {
      return new Response('ASSETS binding is missing', { status: 500 });
    }

    // SPA fallback: serve index.html for non-file paths
    const res = await env.ASSETS.fetch(request);
    if (res.status !== 404) return res;

    if (/\.[a-z0-9]+$/i.test(url.pathname)) return res;

    const indexUrl = new URL(request.url);
    indexUrl.pathname = '/index.html';
    return env.ASSETS.fetch(new Request(indexUrl.toString(), request));
  }
};
```

- [ ] **Step 3: Update wrangler.toml with Durable Object binding**

Add below the existing `[assets]` block:

```toml
# packages/connector-ui/wrangler.toml
name = "agentconnect"
compatibility_date = "2024-07-04"
workers_dev = false
preview_urls = false
send_metrics = false
placement = { mode = "smart" }

main = "worker.mjs"

[assets]
directory = "./dist"
binding = "ASSETS"

[[durable_objects.bindings]]
name = "SESSION_RELAY"
class_name = "SessionRelay"

[[migrations]]
tag = "v1"
new_classes = ["SessionRelay"]

[env.staging]
name = "agentconnect-staging"

routes = [
  { pattern = "agentconnect.staging.polygon.technology", custom_domain = true }
]

[env.production]
name = "agentconnect-production"

routes = [
  { pattern = "agentconnect.polygon.technology", custom_domain = true }
]
```

- [ ] **Step 4: Add shared package dep to connector-ui**

In `packages/connector-ui/package.json`, add to `"dependencies"`:
```json
"@polygonlabs/agent-shared": "workspace:*"
```

And add relay URL to `packages/connector-ui/src/config.ts`:
```typescript
// Add to the bottom of config.ts
export const relayUrl = import.meta.env.VITE_RELAY_URL || '';
// When relayUrl is empty, the SPA calls relative paths (/api/relay/*)
// so it works both locally (proxied) and deployed.
```

- [ ] **Step 5: Run pnpm install to link workspace dep**

```bash
cd /path/to/polygon-agent-kit
pnpm install
```

Expected: no errors, `@polygonlabs/agent-shared` linked in connector-ui node_modules.

- [ ] **Step 6: Commit**

```bash
git add packages/connector-ui/src/relay.ts packages/connector-ui/worker.mjs \
  packages/connector-ui/wrangler.toml packages/connector-ui/package.json \
  packages/connector-ui/src/config.ts
git commit -m "feat(connector-ui): add Durable Object relay API + upgrade worker routing"
```

---

## Task 3: connector-ui — SPA session flow update

**Files:**
- Create: `packages/connector-ui/src/components/CodeDisplay.tsx`
- Modify: `packages/connector-ui/src/App.tsx`

The new flow replaces the sealed-box POST-to-tunnel with:
1. Fetch `cli_pk_hex` from relay (`GET /api/relay/request/:rid`)
2. Connect wallet (same as before)
3. Build `SessionPayload`, call `encryptSession(payload, cli_pk_hex, rid)`
4. POST `EncryptedPayload` to relay (`POST /api/relay/session/:rid`)
5. Show `CodeDisplay` with the 6-digit code

No tunnel, no local server, no callback URL.

- [ ] **Step 1: Create CodeDisplay component (existing Tailwind style)**

```tsx
// packages/connector-ui/src/components/CodeDisplay.tsx
import { Copy, Check } from 'lucide-react';
import { useState } from 'react';

interface CodeDisplayProps {
  code: string;
  walletAddress: string;
  walletName: string;
}

export function CodeDisplay({ code, walletAddress, walletName }: CodeDisplayProps) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const digits = code.split('');

  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <div className="flex flex-col items-center gap-2">
        <h2 className="text-xl font-semibold text-white">Session approved</h2>
        <p className="text-sm text-zinc-400">
          Enter this code in your terminal to complete setup
        </p>
      </div>

      <div className="flex gap-2">
        {digits.map((d, i) => (
          <div
            key={i}
            className="w-10 h-12 flex items-center justify-center rounded-lg bg-zinc-800 border border-zinc-700 text-2xl font-mono font-bold text-white"
          >
            {d}
          </div>
        ))}
      </div>

      <button
        onClick={handleCopy}
        className="flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors"
      >
        {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
        {copied ? 'Copied' : 'Copy code'}
      </button>

      <div className="w-full rounded-lg bg-zinc-800/50 border border-zinc-700/50 p-3 text-left space-y-1">
        <div className="flex justify-between text-xs">
          <span className="text-zinc-500">Wallet</span>
          <span className="text-zinc-300 font-mono">{walletName}</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-zinc-500">Address</span>
          <span className="text-zinc-300 font-mono text-right break-all">{walletAddress}</span>
        </div>
      </div>

      <p className="text-xs text-zinc-500">
        This code expires in 5 minutes. Do not share it.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Update App.tsx — new state machine**

App.tsx is 1090 lines. The changes are targeted:

**2a. Replace imports** — add new imports, remove tweetnacl sealedbox:

Replace:
```typescript
import { seal } from 'tweetnacl-sealedbox-js';
```
With:
```typescript
import { encryptSession, hexToBytes } from '@polygonlabs/agent-shared';
import type { SessionPayload } from '@polygonlabs/agent-shared';
import { CodeDisplay } from './components/CodeDisplay.js';
```

**2b. Update App state** — Add state for new flow. Find the `function App()` block and the existing state declarations. Add:

```typescript
// After existing state declarations inside function App():
const [cliPkHex, setCliPkHex] = useState<string>('');
const [sessionCode, setSessionCode] = useState<string>('');
```

Also update the stage type to include `'code_display'`. Find the existing `stage` state (likely `useState<string>`) and change the type annotation if present to include `'code_display'`.

**2c. Add fetchCliPk effect** — After the existing `useEffect` that reads URL params, add:

```typescript
// Fetch CLI public key from relay on mount (replaces reading 'pub' from URL)
useEffect(() => {
  if (!rid) return;
  const base = window.location.origin; // relay co-hosted
  fetch(`${base}/api/relay/request/${rid}`)
    .then((r) => {
      if (!r.ok) throw new Error(`Relay returned ${r.status}`);
      return r.json() as Promise<{ cli_pk_hex: string }>;
    })
    .then(({ cli_pk_hex }) => setCliPkHex(cli_pk_hex))
    .catch((e) => setError(`Failed to fetch session key: ${e.message}`));
}, [rid]);
```

**2d. Replace the post-connect encryption block** — Find the section in App.tsx that builds the sealed-box payload and POSTs to the callback URL. It starts roughly with code that calls `seal(...)`. Replace that entire block with:

```typescript
// Build SessionPayload for the CLI
const sessionPayloadObj: SessionPayload = {
  version: 1,
  wallet_address: walletAddress,
  chain_id: chainId,
  session_private_key: sessionPk ?? '',
  session_address: sessionConfig?.address ?? '',
  permissions: {
    native_limit: nativeLimitParam
      ? String(BigInt(Math.round(parseFloat(nativeLimitParam) * 1e18)))
      : undefined,
    erc20_limits: buildErc20Limits(), // existing helper or inline
    contract_calls: autoWhitelistedContracts.map((addr) => ({ address: addr, functions: [] }))
  },
  expiry: Math.floor(Date.now() / 1000) + 86400 * 183,
  ecosystem_wallet_url: walletUrl,
  dapp_origin: dappOrigin,
  project_access_key: projectAccessKey,
  session_config: explicitSessionStr, // the stringified full session config
  implicit_session: implicitMeta
    ? {
        pk: implicitPk ?? '',
        attestation: implicitAttestation ?? '',
        identity_sig: implicitIdentitySig ?? ''
      }
    : undefined
};

// Encrypt and post to relay
const { encrypted, code } = encryptSession(sessionPayloadObj, cliPkHex, rid);
const base = window.location.origin;
const relayRes = await fetch(`${base}/api/relay/session/${rid}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(encrypted)
});
if (!relayRes.ok) throw new Error(`Relay rejected session: ${relayRes.status}`);

setSessionCode(code);
setStage('code_display');
```

**Note:** The exact variable names (`sessionPk`, `sessionConfig`, `implicitPk`, etc.) must match what App.tsx currently uses after the dapp-client connect callback. Read the existing post-connect block carefully when implementing and adjust accordingly.

**2e. Add code_display render branch** — In the JSX render section, find where stages are rendered (likely a series of `{stage === 'X' && ...}` branches). Add before the closing tag:

```tsx
{stage === 'code_display' && (
  <CodeDisplay
    code={sessionCode}
    walletAddress={walletAddress}
    walletName={walletName}
  />
)}
```

- [ ] **Step 3: Remove pub param from URL construction note**

The `pub` URL param is no longer used in the connector URL (public key comes from relay). No change needed in the SPA (it just ignores unknown params). The CLI wallet.ts change in Task 4 will stop sending it.

- [ ] **Step 4: Build connector-ui to check for TS errors**

```bash
cd packages/connector-ui
pnpm build
```

Expected: Build completes without TypeScript errors. Fix any type errors before committing.

- [ ] **Step 5: Commit**

```bash
git add packages/connector-ui/src/App.tsx \
  packages/connector-ui/src/components/CodeDisplay.tsx
git commit -m "feat(connector-ui): v2 session flow — relay-based encryption + code display screen"
```

---

## Task 4: polygon-agent-cli — replace tunnel with relay

**Files:**
- Create: `packages/polygon-agent-cli/src/lib/relay-client.ts`
- Modify: `packages/polygon-agent-cli/src/commands/wallet.ts`
- Modify: `packages/polygon-agent-cli/src/lib/storage.ts`
- Modify: `packages/polygon-agent-cli/package.json`

The `wallet create` command currently: generates nacl keypair → starts local HTTP server → spawns cloudflared → waits for POST callback → decrypts sealed-box.

New flow: generates X25519 keypair → registers with relay → opens browser → polls relay for "ready" → prompts user for 6-digit code → retrieves + decrypts from relay → saves session.

- [ ] **Step 1: Add @noble/* and @polygonlabs/agent-shared to CLI deps**

In `packages/polygon-agent-cli/package.json`, add to `"dependencies"`:
```json
"@noble/curves": "^1.8.1",
"@noble/hashes": "^1.7.2",
"@noble/ciphers": "^1.2.1",
"@polygonlabs/agent-shared": "workspace:*"
```

Keep `tweetnacl` for now (other code may use it); it will be removed in a follow-up cleanup.

Run:
```bash
pnpm install
```

- [ ] **Step 2: Create relay-client.ts**

```typescript
// packages/polygon-agent-cli/src/lib/relay-client.ts
import type { EncryptedPayload, RelayCreateResponse, RelayStatusResponse } from '@polygonlabs/agent-shared';

export class RelayClient {
  constructor(private baseUrl: string) {}

  /** Register CLI public key with relay. Returns request_id. */
  async createRequest(cliPkHex: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/relay/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cli_pk_hex: cliPkHex })
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Relay createRequest failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as RelayCreateResponse;
    return data.request_id;
  }

  /** Poll until status is "ready" or timeout. */
  async waitForReady(requestId: string, timeoutMs = 300_000, intervalMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await fetch(`${this.baseUrl}/api/relay/status/${requestId}`);
      if (res.status === 404) throw new Error('Relay request not found (expired or invalid)');
      if (!res.ok) throw new Error(`Relay status check failed (${res.status})`);
      const data = (await res.json()) as RelayStatusResponse;
      if (data.status === 'ready') return;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error('Timed out waiting for wallet approval (5 minutes)');
  }

  /** Submit code hash and retrieve encrypted payload if correct. */
  async retrieve(requestId: string, codeHashHex: string): Promise<EncryptedPayload> {
    const res = await fetch(`${this.baseUrl}/api/relay/retrieve/${requestId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code_hash_hex: codeHashHex })
    });

    if (res.status === 403) {
      const data = (await res.json()) as { attempts_remaining: number };
      throw new RelayCodeError(
        `Wrong code. ${data.attempts_remaining} attempt(s) remaining.`,
        data.attempts_remaining
      );
    }
    if (res.status === 410) throw new RelayCodeError('Too many wrong attempts. Session expired.', 0);
    if (!res.ok) throw new Error(`Relay retrieve failed (${res.status})`);

    return (await res.json()) as EncryptedPayload;
  }
}

export class RelayCodeError extends Error {
  constructor(
    message: string,
    public readonly attemptsRemaining: number
  ) {
    super(message);
    this.name = 'RelayCodeError';
  }
}
```

- [ ] **Step 3: Add session-mapping helper to storage.ts**

The new `SessionPayload` type from shared needs to be mapped into the existing `WalletSession` interface that `dapp-client.ts` reads. Add this function at the bottom of `packages/polygon-agent-cli/src/lib/storage.ts`:

```typescript
import type { SessionPayload } from '@polygonlabs/agent-shared';

/** Map a v2 SessionPayload into the WalletSession shape expected by dapp-client.ts */
export function sessionPayloadToWalletSession(
  payload: SessionPayload,
  walletName: string
): WalletSession {
  const chainName = resolveChainName(payload.chain_id); // see note below
  return {
    walletAddress: payload.wallet_address,
    chainId: payload.chain_id,
    chain: chainName,
    projectAccessKey: payload.project_access_key,
    explicitSession: payload.session_config ?? '',
    sessionPk: payload.session_private_key,
    implicitPk: payload.implicit_session?.pk,
    implicitAttestation: payload.implicit_session?.attestation,
    implicitIdentitySig: payload.implicit_session?.identity_sig,
    createdAt: new Date().toISOString()
  };
}

/** Map numeric chainId to the chain name string used internally (e.g. 137 → "polygon"). */
function resolveChainName(chainId: number): string {
  const map: Record<number, string> = {
    137: 'polygon',
    80002: 'polygon-amoy',
    42161: 'arbitrum',
    10: 'optimism',
    8453: 'base',
    1: 'mainnet'
  };
  return map[chainId] ?? String(chainId);
}
```

Note: `WalletSession` is already defined in `storage.ts` — add this function after its definition.

- [ ] **Step 4: Update wallet.ts — replace tunnel logic with relay**

The key change is in the `wallet create` command handler. Find the handler (the `handler` function or `builder`+`handler` export in the `create` subcommand) in `packages/polygon-agent-cli/src/commands/wallet.ts`.

**4a. Replace nacl keypair generation and tunnel startup** with relay registration:

Remove:
- The `nacl.box.keyPair()` call (or equivalent for sealed-box)
- The `http.createServer(...)` block
- The cloudflared spawn + tunnel URL detection
- The `callbackUrl` construction
- The callback waiting loop
- The sealed-box `sealedbox.open(...)` decryption

Add (replacing that entire block):

```typescript
import readline from 'node:readline';
import { open as openBrowser } from 'open'; // already in node ecosystem or use child_process
// ... inside the handler:
const connectorBase =
  process.env.SEQUENCE_ECOSYSTEM_CONNECTOR_URL?.replace(/\/$/, '') ||
  'https://agentconnect.polygon.technology';
const relayBase = connectorBase; // relay API is co-hosted on same origin

const relay = new RelayClient(relayBase);

// 1. Generate CLI X25519 keypair
const { secretKey: cliSk, publicKey: cliPk } = generateX25519Keypair();
const cliPkHex = bytesToHex(cliPk);

// 2. Register with relay → get request ID
process.stderr.write('Registering with relay...\n');
const rid = await relay.createRequest(cliPkHex);

// 3. Build connector URL (no 'pub' param — key is fetched from relay)
const connectorUrl = new URL(`${connectorBase}/link`);
connectorUrl.searchParams.set('rid', rid);
connectorUrl.searchParams.set('wallet', argv.wallet);
connectorUrl.searchParams.set('chain', argv.chain);
applySessionPermissionParams(connectorUrl, argv); // existing helper

// 4. Open browser (or output URL for --no-wait)
if (argv['no-wait']) {
  console.log(JSON.stringify({ approvalUrl: connectorUrl.toString(), requestId: rid }));
  return;
}

process.stderr.write(`Opening: ${connectorUrl.toString()}\n`);
await open(connectorUrl.toString()).catch(() => {
  process.stderr.write(`Could not open browser. Open manually:\n${connectorUrl.toString()}\n`);
});

// 5. Poll relay until wallet approved
process.stderr.write('Waiting for wallet approval in browser...\n');
await relay.waitForReady(rid);
process.stderr.write('Wallet approved. ');

// 6. Prompt for 6-digit code
const code = await promptCode();

// 7. Retrieve encrypted payload from relay (retry up to 3 times on wrong code)
const codeHashHex = bytesToHex(computeCodeHash(rid, code));
const encrypted = await relay.retrieve(rid, codeHashHex);

// 8. Decrypt session payload
let payload;
try {
  payload = decryptSession(encrypted, cliSk, code, rid);
} catch {
  throw new Error('Decryption failed — wrong code or tampered payload.');
}

// 9. Map to WalletSession and save
const session = sessionPayloadToWalletSession(payload, argv.wallet);
await saveWalletSession(argv.wallet, session);
console.log(
  JSON.stringify({
    walletAddress: session.walletAddress,
    chain: session.chain,
    wallet: argv.wallet
  })
);
```

**4b. Add `promptCode` helper** (add as a module-level function in wallet.ts):

```typescript
function promptCode(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question('Enter the 6-digit code from the browser: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
```

**4c. Add imports** at the top of wallet.ts (replace tweetnacl/sealedbox imports):

```typescript
import readline from 'node:readline';
import open from 'open';
import {
  generateX25519Keypair,
  bytesToHex,
  computeCodeHash,
  decryptSession
} from '@polygonlabs/agent-shared';
import { RelayClient, RelayCodeError } from '../lib/relay-client.ts';
import { sessionPayloadToWalletSession } from '../lib/storage.ts';
```

- [ ] **Step 5: Add `open` dependency**

In `packages/polygon-agent-cli/package.json`, add:
```json
"open": "^10.1.0"
```

Run `pnpm install`.

- [ ] **Step 6: TypeScript check**

```bash
cd packages/polygon-agent-cli
pnpm typecheck
```

Expected: No errors. Fix any before committing.

- [ ] **Step 7: Commit**

```bash
git add packages/polygon-agent-cli/src/lib/relay-client.ts \
  packages/polygon-agent-cli/src/lib/storage.ts \
  packages/polygon-agent-cli/src/commands/wallet.ts \
  packages/polygon-agent-cli/package.json
git commit -m "feat(cli): replace cloudflared tunnel with relay + 6-digit code handoff"
```

---

## Task 5: End-to-end smoke test

This verifies the full flow works locally using the Wrangler dev server.

- [ ] **Step 1: Build connector-ui**

```bash
cd packages/connector-ui
pnpm build
```

Expected: `dist/` populated with SPA assets.

- [ ] **Step 2: Start local Wrangler dev (with Durable Objects)**

```bash
cd packages/connector-ui
npx wrangler dev --local
```

Expected: Worker starts on `http://localhost:8787`. You'll see "Ready on http://localhost:8787".

- [ ] **Step 3: Smoke test relay API**

In a separate terminal:

```bash
# Create a relay request (use a fake 64-char hex cli_pk)
curl -s -X POST http://localhost:8787/api/relay/request \
  -H 'Content-Type: application/json' \
  -d '{"cli_pk_hex":"'$(python3 -c "print('ab'*32)")'"}' | jq .
# Expected: {"request_id":"<8-char-id>"}

RID=<paste request_id here>

# Fetch public key back
curl -s http://localhost:8787/api/relay/request/$RID | jq .
# Expected: {"cli_pk_hex":"abab..."}

# Check status
curl -s http://localhost:8787/api/relay/status/$RID | jq .
# Expected: {"status":"pending"}
```

- [ ] **Step 4: Smoke test full CLI → browser → code flow**

Set env to point CLI at local worker:

```bash
export SEQUENCE_ECOSYSTEM_CONNECTOR_URL=http://localhost:8787
cd packages/polygon-agent-cli
node src/index.ts wallet create --wallet smoketest --chain polygon
```

Expected output:
1. "Registering with relay..." printed to stderr
2. Browser opens to `http://localhost:8787/link?rid=...`
3. After approving in browser (or simulating), code digits displayed in browser
4. Terminal prompts "Enter the 6-digit code from the browser:"
5. After entering code, session saved and JSON printed

- [ ] **Step 5: Commit smoke test result note (optional)**

If any issues found and fixed during smoke test:

```bash
git add -p  # stage only the fixes
git commit -m "fix: smoke test corrections for v2 relay flow"
```

---

## Notes for Figma UI Integration

When Figma designs arrive, the following files are the target for visual updates:

- `packages/connector-ui/src/App.tsx` — stage rendering, layout structure
- `packages/connector-ui/src/components/CodeDisplay.tsx` — the new code screen
- `packages/connector-ui/src/App.css` / `src/index.css` — global styles

The new `CodeDisplay` component uses the same Tailwind patterns as the rest of App.tsx (zinc color scale, rounded-lg, border-zinc-700, etc.). To restyle, update Tailwind classes in `CodeDisplay.tsx`.

---

## Cloudflare Deployment Checklist

When deploying to staging:

```bash
cd packages/connector-ui
pnpm build
npx wrangler deploy --env staging
```

First deploy with Durable Objects requires the migration to be applied. Wrangler handles this automatically via the `[[migrations]]` block in wrangler.toml (class `SessionRelay`, tag `v1`).

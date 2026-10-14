import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from './index.ts';

import { issueCertificate, resetJwksCache } from './agent-auth.ts';
import { handleApi } from './index.ts';
import {
  AGENT,
  AUDIENCE,
  ISSUER,
  makeIssuer,
  mintAccessToken,
  SECRET,
  WALLET
} from './test-helpers.ts';

const ADDRESS = {
  name: 'Test Agent',
  line1: '214 Bergen St',
  line2: '',
  city: 'Brooklyn',
  state: 'NY',
  zip: '11217',
  country: 'US',
  phone: ''
};

// A tiny in-memory Workers KV.
function fakeKv() {
  const data = new Map<string, string>();
  const kv = {
    get: async (k: string) => data.get(k) ?? null,
    put: async (k: string, v: string) => void data.set(k, v)
  } as unknown as KVNamespace;
  return { data, kv };
}

let kv: ReturnType<typeof fakeKv>;

const env = (over: Partial<Env> = {}): Env => ({
  ASSETS: {} as Fetcher,
  AGENT_CERT_SECRET: SECRET,
  CREDENTIALS: kv.kv,
  CREDENTIALS_KEY: 'test-credentials-key',
  OMS_ID_TOKEN_ISSUER: ISSUER,
  OMS_ID_TOKEN_AUDIENCES: AUDIENCE,
  OMS_JWKS_URL: 'https://jwks.test',
  ...over
});

let jwksFetch: typeof fetch;

beforeEach(async () => {
  resetJwksCache();
  kv = fakeKv();
  const iss = await makeIssuer();
  jwksFetch = iss.fetchImpl;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://jwks.test') return jwksFetch(url, init);
    return new Response('unexpected fetch', { status: 599 });
  });
  issuer = iss;
});
afterEach(() => vi.unstubAllGlobals());

let issuer: Awaited<ReturnType<typeof makeIssuer>>;

async function token() {
  const { certificate } = await issueCertificate(
    { wallet: WALLET, agentKey: AGENT.address.toLowerCase(), email: 'owner@example.com' },
    SECRET
  );
  return mintAccessToken(certificate);
}

const req = (method: string, path: string, opts: { token?: string; body?: unknown } = {}) =>
  new Request(`https://agentconnect.test${path}`, {
    method,
    headers: {
      ...(opts.token ? { Authorization: `Agent ${opts.token}` } : {}),
      ...(opts.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });

describe('POST /api/agent/enroll', () => {
  it('issues a certificate for a valid OMS token', async () => {
    const idToken = await issuer.sign(issuer.enrollClaims());
    const res = await handleApi(
      req('POST', '/api/agent/enroll', { body: { idToken } }),
      env(),
      '/api/agent/enroll'
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { certificate: string; wallet: string };
    expect(body.wallet).toBe(WALLET);
    expect(body.certificate).toMatch(/^c1\./);
  });

  it('refuses a bad token', async () => {
    const idToken = await issuer.sign(issuer.enrollClaims({ aud: ['prj_other'] }));
    const res = await handleApi(
      req('POST', '/api/agent/enroll', { body: { idToken } }),
      env(),
      '/api/agent/enroll'
    );
    expect(res.status).toBe(401);
  });
});

describe('/api/credentials/address', () => {
  const path = '/api/credentials/address';

  it('requires an agent token', async () => {
    const res = await handleApi(req('GET', path), env(), path);
    expect(res.status).toBe(401);
  });

  it('returns null before anything is saved', async () => {
    const res = await handleApi(req('GET', path, { token: await token() }), env(), path);
    expect(await res.json()).toEqual({ address: null });
  });

  it('saves the address sealed, then reads it back', async () => {
    const t = await token();
    const put = await handleApi(req('PUT', path, { token: t, body: ADDRESS }), env(), path);
    expect(put.status).toBe(200);
    const stored = kv.data.get(`wallet:${WALLET}`)!;
    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain('Bergen');

    const get = await handleApi(req('GET', path, { token: t }), env(), path);
    expect(await get.json()).toEqual({ address: ADDRESS });
  });

  it('replaces the saved address', async () => {
    const t = await token();
    await handleApi(req('PUT', path, { token: t, body: ADDRESS }), env(), path);
    await handleApi(
      req('PUT', path, { token: t, body: { ...ADDRESS, city: 'Queens' } }),
      env(),
      path
    );
    const get = await handleApi(req('GET', path, { token: t }), env(), path);
    expect(await get.json()).toEqual({ address: { ...ADDRESS, city: 'Queens' } });
  });

  it('clears the address', async () => {
    const t = await token();
    await handleApi(req('PUT', path, { token: t, body: ADDRESS }), env(), path);
    await handleApi(req('DELETE', path, { token: t }), env(), path);
    const get = await handleApi(req('GET', path, { token: t }), env(), path);
    expect(await get.json()).toEqual({ address: null });
  });

  it('refuses a record moved under another wallet', async () => {
    const t = await token();
    await handleApi(req('PUT', path, { token: t, body: ADDRESS }), env(), path);
    const other = '0x00000000000000000000000000000000000000bb';
    kv.data.set(`wallet:${other}`, kv.data.get(`wallet:${WALLET}`)!);
    const { CredentialStore } = await import('./store.ts');
    await expect(new CredentialStore(kv.kv, 'test-credentials-key').get(other)).rejects.toThrow();
  });

  it('validates the address', async () => {
    const res = await handleApi(
      req('PUT', path, { token: await token(), body: { ...ADDRESS, line1: '' } }),
      env(),
      path
    );
    expect(res.status).toBe(400);
    expect(kv.data.size).toBe(0);
  });

  it('answers 503 when storage is not configured', async () => {
    const res = await handleApi(
      req('GET', path, { token: await token() }),
      env({ CREDENTIALS_KEY: undefined }),
      path
    );
    expect(res.status).toBe(503);
  });
});

describe('without a certificate secret', () => {
  it('answers 503', async () => {
    const res = await handleApi(
      req('GET', '/api/credentials/address'),
      env({ AGENT_CERT_SECRET: undefined }),
      '/api/credentials/address'
    );
    expect(res.status).toBe(503);
  });
});

describe('global fetch binding', () => {
  it('never calls fetch as a method (Workers throw Illegal invocation)', async () => {
    const strict = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return jwksFetch(String(input), init);
    };
    vi.stubGlobal('fetch', strict);
    const idToken = await issuer.sign(issuer.enrollClaims());
    const res = await handleApi(
      req('POST', '/api/agent/enroll', { body: { idToken } }),
      env(),
      '/api/agent/enroll'
    );
    expect(res.status).toBe(200);
  });
});

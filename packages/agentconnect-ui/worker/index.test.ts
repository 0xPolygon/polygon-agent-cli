import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from './index.ts';

import { issueCertificate, resetJwksCache } from './agent-auth.ts';
import { handleApi } from './index.ts';
import { resetOmsTokenCache } from './oms-customers.ts';
import {
  AGENT,
  AUDIENCE,
  ISSUER,
  makeIssuer,
  mintAccessToken,
  SECRET,
  WALLET
} from './test-helpers.ts';

const OMS = 'https://oms.test/v0.13';
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

const env = (over: Partial<Env> = {}): Env => ({
  ASSETS: {} as Fetcher,
  AGENT_CERT_SECRET: SECRET,
  OMS_API_URL: OMS,
  OMS_API_KEY: 'sk_test',
  OMS_API_SECRET: 'secret',
  OMS_ID_TOKEN_ISSUER: ISSUER,
  OMS_ID_TOKEN_AUDIENCES: AUDIENCE,
  OMS_JWKS_URL: 'https://jwks.test',
  ...over
});

// A tiny in-memory OMS customers API.
function fakeOms() {
  const customers: {
    id: string;
    externalId: string;
    email?: string;
    metadata: Record<string, string>;
  }[] = [];
  const calls: string[] = [];
  const handler = async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(OMS, '');
    calls.push(`${method} ${path.split('?')[0]}`);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (path === '/auth/token') return Response.json({ accessToken: 'tok', expiresIn: 3600 });
    if (method === 'GET' && path.startsWith('/customers?')) {
      const ext = new URL(`https://x${path}`).searchParams.get('externalId');
      return Response.json({ data: customers.filter((c) => c.externalId === ext), hasMore: false });
    }
    if (method === 'POST' && path === '/customers') {
      const c = { id: `cst_${customers.length + 1}`, ...body };
      customers.push(c);
      return Response.json(c, { status: 201 });
    }
    const m = /^\/customers\/(.+)$/.exec(path);
    if (method === 'PATCH' && m) {
      const c = customers.find((x) => x.id === m[1])!;
      // Replace semantics: the worker always sends the full map.
      c.metadata = body.metadata;
      return Response.json(c);
    }
    return Response.json({ error: 'NotFound' }, { status: 404 });
  };
  return { customers, calls, handler };
}

let oms: ReturnType<typeof fakeOms>;
let jwksFetch: typeof fetch;

beforeEach(async () => {
  resetJwksCache();
  resetOmsTokenCache();
  oms = fakeOms();
  const iss = await makeIssuer();
  jwksFetch = iss.fetchImpl;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://jwks.test') return jwksFetch(url, init);
    return oms.handler(url, init);
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

  it('creates the customer on first save, then reads it back', async () => {
    const t = await token();
    const put = await handleApi(req('PUT', path, { token: t, body: ADDRESS }), env(), path);
    expect(put.status).toBe(200);
    expect(oms.customers).toHaveLength(1);
    expect(oms.customers[0]).toMatchObject({ externalId: WALLET, email: 'owner@example.com' });
    expect(oms.customers[0].metadata).toMatchObject({
      ship_line1: '214 Bergen St',
      ship_city: 'Brooklyn'
    });

    const get = await handleApi(req('GET', path, { token: t }), env(), path);
    expect(await get.json()).toEqual({ address: ADDRESS });
  });

  it('updates the existing customer instead of creating another', async () => {
    const t = await token();
    await handleApi(req('PUT', path, { token: t, body: ADDRESS }), env(), path);
    await handleApi(
      req('PUT', path, { token: t, body: { ...ADDRESS, city: 'Queens' } }),
      env(),
      path
    );
    expect(oms.customers).toHaveLength(1);
    expect(oms.customers[0].metadata.ship_city).toBe('Queens');
  });

  it('clears the address', async () => {
    const t = await token();
    await handleApi(req('PUT', path, { token: t, body: ADDRESS }), env(), path);
    await handleApi(req('DELETE', path, { token: t }), env(), path);
    const get = await handleApi(req('GET', path, { token: t }), env(), path);
    expect(await get.json()).toEqual({ address: null });
    expect(oms.customers[0].metadata.agentconnect_wallet).toBe(WALLET);
  });

  it('validates the address', async () => {
    const res = await handleApi(
      req('PUT', path, { token: await token(), body: { ...ADDRESS, line1: '' } }),
      env(),
      path
    );
    expect(res.status).toBe(400);
    expect(oms.customers).toHaveLength(0);
  });

  it('answers 503 when OMS is not configured', async () => {
    const res = await handleApi(
      req('GET', path, { token: await token() }),
      env({ OMS_API_SECRET: undefined }),
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
      return oms.handler(String(input), init);
    };
    vi.stubGlobal('fetch', strict);
    const res = await handleApi(
      req('GET', '/api/credentials/address', { token: await token() }),
      env(),
      '/api/credentials/address'
    );
    expect(res.status).toBe(200);
  });
});

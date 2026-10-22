import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from './index.ts';

import { issueCertificate, resetJwksCache } from './agent-auth.ts';
import {
  agentName,
  handleAgentsApi,
  handleApi,
  handleConnectApi,
  isLocalAgent,
  limitRegistration,
  handleSessionApi
} from './index.ts';
import { issueSession, SESSION_COOKIE } from './owner-session.ts';
import { OwnerSignIn } from './owner-signin.ts';
import { CredentialStore, SealedKv } from './store.ts';
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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

  it("links the owner's verified email to the agent wallet", async () => {
    const idToken = await issuer.sign(issuer.enrollClaims());
    await handleApi(
      req('POST', '/api/agent/enroll', { body: { idToken } }),
      env(),
      '/api/agent/enroll'
    );
    const db = new CredentialStore(kv.kv, 'test-credentials-key');
    expect(await db.ownerWallet('Owner@Example.com')).toBe(WALLET);
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

describe('signed in on the site (session cookie)', () => {
  const path = '/api/credentials/address';
  const cookie = async () =>
    `${SESSION_COOKIE}=${await issueSession({ wallet: WALLET, email: 'owner@example.com' }, SECRET)}`;
  const withCookie = (method: string, c: string, origin?: string, body?: unknown) =>
    new Request(`https://agentconnect.test${path}`, {
      method,
      headers: {
        Cookie: c,
        ...(origin ? { Origin: origin } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

  it('reads and saves the address without an agent token', async () => {
    const c = await cookie();
    const put = await handleApi(
      withCookie('PUT', c, 'https://agentconnect.test', ADDRESS),
      env(),
      path
    );
    expect(put.status).toBe(200);
    const get = await handleApi(withCookie('GET', c), env(), path);
    expect(await get.json()).toEqual({ address: ADDRESS });
  });

  it('refuses changes posted from another site', async () => {
    const res = await handleApi(
      withCookie('PUT', await cookie(), 'https://evil.test', ADDRESS),
      env(),
      path
    );
    expect(res.status).toBe(401);
    expect(kv.data.size).toBe(0);
  });

  it('refuses a tampered cookie', async () => {
    const c = (await cookie()).slice(0, -2) + 'xx';
    const res = await handleApi(withCookie('GET', c), env(), path);
    expect(res.status).toBe(401);
  });

  it('refuses an expired session', async () => {
    const old = await issueSession({ wallet: WALLET, email: null }, SECRET, 1_000);
    const res = await handleApi(withCookie('GET', `${SESSION_COOKIE}=${old}`), env(), path);
    expect(res.status).toBe(401);
  });

  it("signs the owner in to their agent's wallet, whichever wallet the sign-in made", async () => {
    await new CredentialStore(kv.kv, 'test-credentials-key').linkOwner('owner@example.com', WALLET);
    const other = '0x' + '1'.repeat(40);
    vi.spyOn(OwnerSignIn.prototype, 'finishEmail').mockResolvedValue({
      wallet: other,
      email: 'owner@example.com'
    });
    vi.spyOn(OwnerSignIn.prototype, 'forget').mockResolvedValue();
    const res = await handleSessionApi(
      req('POST', '/api/session/email/finish', { body: { c: 'c1', code: '123456' } }),
      env({ OAUTH_KV: fakeKv().kv }),
      '/api/session/email/finish'
    );
    expect(await res.json()).toEqual({ wallet: WALLET, email: 'owner@example.com' });
  });

  it('GET /api/session names the wallet; DELETE clears the cookie', async () => {
    const e = env({ OAUTH_KV: fakeKv().kv });
    const c = await cookie();
    const who = await handleSessionApi(
      new Request('https://agentconnect.test/api/session', { headers: { Cookie: c } }),
      e,
      '/api/session'
    );
    expect(await who.json()).toEqual({ wallet: WALLET, email: 'owner@example.com' });

    const none = await handleSessionApi(
      new Request('https://agentconnect.test/api/session'),
      e,
      '/api/session'
    );
    expect(none.status).toBe(401);

    const out = await handleSessionApi(
      new Request('https://agentconnect.test/api/session', { method: 'DELETE' }),
      e,
      '/api/session'
    );
    expect(out.headers.get('Set-Cookie')).toMatch(
      new RegExp(`^${SESSION_COOKIE}=;.*HttpOnly.*Max-Age=0.*Secure`)
    );
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

describe('connecting an agent (consent)', () => {
  const ORIGIN = 'https://agentconnect.test';
  const authRequest = {
    responseType: 'code',
    clientId: 'cli_1',
    redirectUri: 'http://localhost:9999/callback',
    scope: ['wallet'],
    state: 'st_1',
    codeChallenge: 'x',
    codeChallengeMethod: 'S256'
  };
  const cookie = async () =>
    `${SESSION_COOKIE}=${await issueSession({ wallet: WALLET, email: 'owner@example.com' }, SECRET)}`;

  function setup() {
    const oauthKv = fakeKv();
    const completed: unknown[] = [];
    const revoked: [string, string][] = [];
    const grants = [
      {
        id: 'g1',
        clientId: 'cli_1',
        userId: WALLET,
        scope: ['wallet'],
        metadata: { clientName: 'Claude Code' },
        createdAt: 100
      },
      {
        id: 'g2',
        clientId: 'cli_2',
        userId: WALLET,
        scope: ['wallet'],
        metadata: {},
        createdAt: 200
      }
    ];
    const provider = {
      completeAuthorization: async (o: unknown) => {
        completed.push(o);
        return { redirectTo: 'http://localhost:9999/callback?code=abc&state=st_1' };
      },
      listUserGrants: async (userId: string) => ({
        items: grants.filter((g) => g.userId === userId)
      }),
      revokeGrant: async (id: string, userId: string) => {
        revoked.push([id, userId]);
      }
    };
    const e = env({
      OAUTH_KV: oauthKv.kv,
      OAUTH_PROVIDER: provider as unknown as Env['OAUTH_PROVIDER']
    });
    const signIn = new OwnerSignIn(new SealedKv(oauthKv.kv, 'test-credentials-key'), 'pk_test');
    return { e, signIn, completed, revoked };
  }
  const call = (
    e: Env,
    method: string,
    path: string,
    opts: { cookie?: string; body?: unknown } = {}
  ) =>
    handleConnectApi(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          ...(opts.cookie ? { Cookie: opts.cookie } : {}),
          ...(opts.body ? { 'Content-Type': 'application/json', Origin: ORIGIN } : {})
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined
      }),
      e,
      new URL(`${ORIGIN}${path}`).pathname
    );

  it('asks a signed-out owner to sign in', async () => {
    const { e, signIn } = setup();
    const c = await signIn.create({ authRequest: authRequest as never, clientName: 'Claude Code' });
    const res = await call(e, 'GET', `/api/connect?c=${c}`);
    expect(await res.json()).toEqual({ clientName: 'Claude Code', signedIn: false });
  });

  it('refuses to allow before sign-in', async () => {
    const { e, signIn, completed } = setup();
    const c = await signIn.create({ authRequest: authRequest as never, clientName: 'Claude Code' });
    const res = await call(e, 'POST', '/api/connect/decide', { body: { c, allow: true } });
    expect(res.status).toBe(400);
    expect(completed).toHaveLength(0);
  });

  it('skips sign-in for an owner signed in on the site', async () => {
    const { e, signIn, completed } = setup();
    const c = await signIn.create({ authRequest: authRequest as never, clientName: 'Claude Code' });
    const res = await call(e, 'GET', `/api/connect?c=${c}`, { cookie: await cookie() });
    expect(await res.json()).toEqual({
      clientName: 'Claude Code',
      signedIn: true,
      email: 'owner@example.com',
      localAgent: true
    });
    const allow = await call(e, 'POST', '/api/connect/decide', {
      cookie: await cookie(),
      body: { c, allow: true }
    });
    expect(await allow.json()).toEqual({
      redirectTo: 'http://localhost:9999/callback?code=abc&state=st_1'
    });
    expect(completed[0]).toMatchObject({
      userId: WALLET,
      props: { wallet: WALLET, profile: 'standard' },
      metadata: { profile: 'standard' }
    });
  });

  it("won't let anyone but the signed-in browser allow, even with the request's id", async () => {
    const { e, signIn, completed } = setup();
    const c = await signIn.create({ authRequest: authRequest as never, clientName: 'Claude Code' });
    // The owner opens the link; whoever started the request knows c.
    await call(e, 'GET', `/api/connect?c=${c}`, { cookie: await cookie() });
    const bare = await call(e, 'POST', '/api/connect/decide', { body: { c, allow: true } });
    expect(bare.status).toBe(401);
    const other = `${SESSION_COOKIE}=${await issueSession({ wallet: '0x' + '1'.repeat(40), email: null }, SECRET)}`;
    const theirs = await call(e, 'POST', '/api/connect/decide', {
      cookie: other,
      body: { c, allow: true }
    });
    expect(theirs.status).toBe(401);
    expect(completed).toHaveLength(0);
    // The owner can still decide.
    const mine = await call(e, 'POST', '/api/connect/decide', {
      cookie: await cookie(),
      body: { c, allow: true }
    });
    expect(mine.status).toBe(200);
    expect(completed).toHaveLength(1);
  });

  it('gives a client mapped to a profile that profile, for the life of the connection', async () => {
    const { e, signIn, completed } = setup();
    e.MCP_CLIENT_PROFILES = JSON.stringify({ cli_1: 'muse' });
    const c = await signIn.create({ authRequest: authRequest as never, clientName: 'Muse' });
    await call(e, 'GET', `/api/connect?c=${c}`, { cookie: await cookie() });
    await call(e, 'POST', '/api/connect/decide', {
      cookie: await cookie(),
      body: { c, allow: true }
    });
    expect(completed[0]).toMatchObject({ props: { profile: 'muse' } });
  });

  it("sends the agent back with access_denied on Don't allow", async () => {
    const { e, signIn, completed } = setup();
    const c = await signIn.create({ authRequest: authRequest as never, clientName: 'Claude Code' });
    await call(e, 'GET', `/api/connect?c=${c}`, { cookie: await cookie() });
    const res = await call(e, 'POST', '/api/connect/decide', {
      cookie: await cookie(),
      body: { c, allow: false }
    });
    const { redirectTo } = (await res.json()) as { redirectTo: string };
    const back = new URL(redirectTo);
    expect(back.origin + back.pathname).toBe('http://localhost:9999/callback');
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('st_1');
    expect(completed).toHaveLength(0);
  });

  it('lists connected agents for the signed-in owner, newest first, and disconnects one', async () => {
    const { e, revoked } = setup();
    const c = await cookie();
    const list = await handleAgentsApi(
      new Request(`${ORIGIN}/api/agents`, { headers: { Cookie: c } }),
      e,
      '/api/agents'
    );
    expect(await list.json()).toEqual({
      agents: [
        { id: 'g2', name: 'An agent', connectedAt: 200 },
        { id: 'g1', name: 'Claude Code', connectedAt: 100 }
      ]
    });
    const del = await handleAgentsApi(
      new Request(`${ORIGIN}/api/agents/g1`, {
        method: 'DELETE',
        headers: { Cookie: c, Origin: ORIGIN }
      }),
      e,
      '/api/agents/g1'
    );
    expect(del.status).toBe(200);
    expect(revoked).toEqual([['g1', WALLET]]);
  });

  it('keeps the agent list from agents and other sites', async () => {
    const { e, revoked } = setup();
    const withToken = await handleAgentsApi(
      new Request(`${ORIGIN}/api/agents`, { headers: { Authorization: `Agent ${await token()}` } }),
      e,
      '/api/agents'
    );
    expect(withToken.status).toBe(401);
    const crossSite = await handleAgentsApi(
      new Request(`${ORIGIN}/api/agents/g1`, {
        method: 'DELETE',
        headers: { Cookie: await cookie(), Origin: 'https://evil.test' }
      }),
      e,
      '/api/agents/g1'
    );
    expect(crossSite.status).toBe(401);
    expect(revoked).toHaveLength(0);
  });
});

describe('agentName', () => {
  it('drops the server label MCP clients add', () => {
    expect(agentName('Claude Code (polygon-wallet)')).toBe('Claude Code');
    expect(agentName('Muse')).toBe('Muse');
    expect(agentName('')).toBe('An agent');
    expect(agentName('(polygon-wallet)')).toBe('An agent');
  });
});

describe('MCP client registration', () => {
  const register = (ip: string, method = 'POST') =>
    new Request('https://agentconnect.test/oauth/register', {
      method,
      headers: { 'CF-Connecting-IP': ip }
    });
  // Like the Workers binding: a fixed number of calls per key.
  const limiter = (max: number) => {
    const seen = new Map<string, number>();
    return {
      limit: async ({ key }: { key: string }) => {
        seen.set(key, (seen.get(key) ?? 0) + 1);
        return { success: seen.get(key)! <= max };
      }
    };
  };

  it('caps registrations from one address', async () => {
    const e = env({ REGISTER_LIMITER: limiter(2) });
    expect(await limitRegistration(register('1.1.1.1'), e)).toBeNull();
    expect(await limitRegistration(register('1.1.1.1'), e)).toBeNull();
    const third = await limitRegistration(register('1.1.1.1'), e);
    expect(third?.status).toBe(429);
    expect(third?.headers.get('Retry-After')).toBe('60');
    expect(await limitRegistration(register('2.2.2.2'), e)).toBeNull();
  });

  it('leaves other routes alone', async () => {
    const e = env({ REGISTER_LIMITER: limiter(0) });
    expect(await limitRegistration(register('1.1.1.1', 'GET'), e)).toBeNull();
    const token = new Request('https://agentconnect.test/oauth/token', { method: 'POST' });
    expect(await limitRegistration(token, e)).toBeNull();
  });
});

describe('isLocalAgent', () => {
  it('is true for a callback on this machine or an app link', () => {
    expect(isLocalAgent('http://localhost:9999/callback')).toBe(true);
    expect(isLocalAgent('http://127.0.0.1:53682/cb')).toBe(true);
    expect(isLocalAgent('http://[::1]:8080/cb')).toBe(true);
    expect(isLocalAgent('cursor://anysphere.cursor-retrieval/oauth/callback')).toBe(true);
    expect(isLocalAgent('https://claude.ai/api/mcp/auth_callback')).toBe(false);
    expect(isLocalAgent('http://localhost.evil.com/cb')).toBe(false);
    expect(isLocalAgent('not a url')).toBe(false);
  });
});

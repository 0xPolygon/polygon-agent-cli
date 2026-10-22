import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from './index.ts';

import {
  agentName,
  handleAgentsApi,
  handleConnectApi,
  isLocalAgent,
  limitRegistration,
  openaiChallenge,
  handleSessionApi
} from './index.ts';
import { issueSession, SESSION_COOKIE } from './owner-session.ts';
import { OwnerSignIn } from './owner-signin.ts';
import { SealedKv } from './store.ts';
import { SECRET, WALLET } from './test-helpers.ts';

// A tiny in-memory Workers KV.
function fakeKv() {
  const data = new Map<string, string>();
  const kv = {
    get: async (k: string) => data.get(k) ?? null,
    put: async (k: string, v: string) => void data.set(k, v)
  } as unknown as KVNamespace;
  return { data, kv };
}

const env = (over: Partial<Env> = {}): Env => ({
  ASSETS: {} as Fetcher,
  AGENT_CERT_SECRET: SECRET,
  CREDENTIALS_KEY: 'test-credentials-key',
  ...over
});

beforeEach(() => {
  vi.stubGlobal('fetch', async () => new Response('unexpected fetch', { status: 599 }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const req = (method: string, path: string, opts: { body?: unknown } = {}) =>
  new Request(`https://agentconnect.test${path}`, {
    method,
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });

describe('signed in on the site (session cookie)', () => {
  const path = '/api/agents';
  const cookie = async () =>
    `${SESSION_COOKIE}=${await issueSession({ wallet: WALLET, email: 'owner@example.com' }, SECRET)}`;
  const agents = (method: string, c: string, origin?: string) =>
    handleAgentsApi(
      new Request(`https://agentconnect.test${path}${method === 'DELETE' ? '/g1' : ''}`, {
        method,
        headers: { Cookie: c, ...(origin ? { Origin: origin } : {}) }
      }),
      env({
        OAUTH_PROVIDER: {
          listUserGrants: async () => ({ items: [] }),
          revokeGrant: async () => {}
        } as unknown as Env['OAUTH_PROVIDER']
      }),
      `${path}${method === 'DELETE' ? '/g1' : ''}`
    );

  it('accepts the cookie for this site', async () => {
    expect((await agents('GET', await cookie())).status).toBe(200);
    expect((await agents('DELETE', await cookie(), 'https://agentconnect.test')).status).toBe(200);
  });

  it('refuses changes posted from another site', async () => {
    expect((await agents('DELETE', await cookie(), 'https://evil.test')).status).toBe(401);
  });

  it('refuses a tampered cookie', async () => {
    const c = (await cookie()).slice(0, -2) + 'xx';
    expect((await agents('GET', c)).status).toBe(401);
  });

  it('refuses an expired session', async () => {
    const old = await issueSession({ wallet: WALLET, email: null }, SECRET, 1_000);
    expect((await agents('GET', `${SESSION_COOKIE}=${old}`)).status).toBe(401);
  });

  it('signs the owner in to the wallet the sign-in found', async () => {
    vi.spyOn(OwnerSignIn.prototype, 'finishEmail').mockResolvedValue({
      wallet: WALLET,
      email: 'owner@example.com'
    });
    vi.spyOn(OwnerSignIn.prototype, 'forget').mockResolvedValue();
    const res = await handleSessionApi(
      req('POST', '/api/session/email/finish', { body: { c: 'c1', code: '123456' } }),
      env({ OAUTH_KV: fakeKv().kv }),
      '/api/session/email/finish'
    );
    expect(await res.json()).toEqual({ wallet: WALLET, email: 'owner@example.com' });
    expect(res.headers.get('Set-Cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=os1\\.`));
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
    const res = await handleSessionApi(
      req('GET', '/api/session'),
      env({ AGENT_CERT_SECRET: undefined, OAUTH_KV: fakeKv().kv }),
      '/api/session'
    );
    expect(res.status).toBe(503);
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
    expect(back.searchParams.get('iss')).toBe(ORIGIN);
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

  it('keeps the agent list from anyone not signed in, and from other sites', async () => {
    const { e, revoked } = setup();
    const signedOut = await handleAgentsApi(new Request(`${ORIGIN}/api/agents`), e, '/api/agents');
    expect(signedOut.status).toBe(401);
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

describe('openaiChallenge', () => {
  it('serves the portal token as plain text, and nothing until one is set', async () => {
    const res = openaiChallenge(env({ OPENAI_APPS_CHALLENGE: 'tok_123' }));
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    expect(await res.text()).toBe('tok_123');
    expect(openaiChallenge(env()).status).toBe(404);
    expect(openaiChallenge(env({ OPENAI_APPS_CHALLENGE: '' })).status).toBe(404);
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

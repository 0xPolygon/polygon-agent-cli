import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from './index.ts';

import { issueCertificate, resetJwksCache } from './agent-auth.ts';
import { resetAgentCardTokenCache } from './agentcard.ts';
import { handleApi } from './index.ts';
import { CredentialStore } from './store.ts';
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

// A tiny AgentCard vault: sessions link when the test says the user finished.
function fakeAgentCard() {
  const sessions = new Map<string, { user_id: string | null; status: string; card: boolean }>();
  // Vault users with a phone or email for the sign-in code.
  const withContact = new Set<string>();
  const cards = new Map<
    string,
    {
      id: string;
      brand: string;
      last4: string;
      expiry_month: number;
      expiry_year: number;
      created_at: string;
    }[]
  >();
  const created: { user_id?: string }[] = [];
  const exchanged = new Set<string>();
  const refreshed: string[] = [];
  const buys: { auth: string | null; body: Record<string, unknown> }[] = [];
  let n = 0;
  const handler = async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    if (u.pathname === '/api/v2/oauth/token')
      return Response.json({ access_token: 'ac', expires_in: 3600 });
    if (method === 'POST' && u.pathname === '/api/v2/vault_sessions') {
      const body = JSON.parse(String(init.body));
      created.push(body);
      if (body.user_id && !withContact.has(body.user_id)) {
        return Response.json(
          { error: { code: 'contact_missing', message: 'no contact' } },
          { status: 422 }
        );
      }
      const id = `vs_${++n}`;
      sessions.set(id, { user_id: body.user_id ?? null, status: 'pending', card: false });
      return Response.json(
        {
          id,
          url: `https://vault.test/v?vs=${id}.sig`,
          user_id: body.user_id ?? null,
          expires_at: '2026-10-13T00:00:00Z',
          poll_interval: 3
        },
        { status: 201 }
      );
    }
    const sm = /^\/api\/v2\/vault_sessions\/(.+)$/.exec(u.pathname);
    if (method === 'GET' && sm) {
      const sess = sessions.get(sm[1]);
      return sess
        ? Response.json({ id: sm[1], ...sess, poll_interval: 3 })
        : Response.json({}, { status: 404 });
    }
    const ex = /^\/api\/v2\/vault_sessions\/(.+)\/exchange$/.exec(u.pathname);
    if (method === 'POST' && ex) {
      const sess = sessions.get(ex[1]);
      if (!sess?.user_id) return Response.json({}, { status: 404 });
      if (exchanged.has(ex[1])) {
        return Response.json({ error: { code: 'already_exchanged' } }, { status: 410 });
      }
      exchanged.add(ex[1]);
      return Response.json({
        access_token: `act_${sess.user_id}`,
        refresh_token: 'rct_1',
        expires_in: 3600,
        user: { id: sess.user_id }
      });
    }
    if (method === 'POST' && u.pathname === '/api/v2/connect/refresh') {
      refreshed.push(JSON.parse(String(init.body)).refresh_token);
      return Response.json({ access_token: 'act_new', refresh_token: 'rct_2', expires_in: 3600 });
    }
    if (method === 'POST' && u.pathname === '/buy') {
      const body = JSON.parse(String(init.body));
      buys.push({ auth: new Headers(init.headers).get('Authorization'), body });
      const cart = {
        merchant: 'retail',
        items: [{ name: 'Coffee', qty: 1, priceCents: 659 }],
        totalCents: 675,
        hash: '0123456789abcdef'
      };
      return Response.json(
        body.confirm
          ? {
              conversation_id: 'conv_1',
              status: 'declined',
              decline_code: 'vault_approval_required',
              approval_url: 'https://vault.test/authorize?id=cauth_1',
              charge_status: 'none',
              cart
            }
          : { conversation_id: 'conv_1', status: 'needs_input', reply: 'Found it.', cart }
      );
    }
    if (method === 'GET' && u.pathname === '/api/v2/vault_cards') {
      const list = cards.get(u.searchParams.get('user_id') ?? '');
      return list
        ? Response.json({ object: 'list', data: list })
        : Response.json({ error: { code: 'connection_not_found' } }, { status: 404 });
    }
    return Response.json({}, { status: 404 });
  };
  // The passkey user exists: AgentCard says linked, but no card is stored yet.
  const passkey = (id: string, user: string) =>
    sessions.set(id, { user_id: user, status: 'linked', card: false });
  const finish = (id: string, user: string, last4 = '4242') => {
    sessions.set(id, { user_id: user, status: 'linked', card: true });
    cards.set(user, [
      ...(cards.get(user) ?? []),
      {
        id: `vc_${last4}`,
        brand: 'visa',
        last4,
        expiry_month: 12,
        expiry_year: 2029,
        created_at: '2026-10-12T00:00:00Z'
      }
    ]);
  };
  return { handler, passkey, finish, created, withContact, buys, refreshed };
}

let agentcard: ReturnType<typeof fakeAgentCard>;

const env = (over: Partial<Env> = {}): Env => ({
  ASSETS: {} as Fetcher,
  AGENT_CERT_SECRET: SECRET,
  CREDENTIALS: kv.kv,
  CREDENTIALS_KEY: 'test-credentials-key',
  OMS_ID_TOKEN_ISSUER: ISSUER,
  OMS_ID_TOKEN_AUDIENCES: AUDIENCE,
  OMS_JWKS_URL: 'https://jwks.test',
  AGENTCARD_CLIENT_ID: 'client',
  AGENTCARD_CLIENT_SECRET: 'acs_secret',
  ...over
});

let jwksFetch: typeof fetch;

beforeEach(async () => {
  resetJwksCache();
  kv = fakeKv();
  agentcard = fakeAgentCard();
  resetAgentCardTokenCache();
  const iss = await makeIssuer();
  jwksFetch = iss.fetchImpl;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://jwks.test') return jwksFetch(url, init);
    if (url.startsWith('https://api.agentcard.sh')) return agentcard.handler(url, init);
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

describe('/api/credentials/cards', () => {
  const call = async (method: string, path: string, t: string) =>
    handleApi(req(method, path, { token: t }), env(), new URL(`https://x${path}`).pathname);
  const start = async (t: string) =>
    (await (await call('POST', '/api/credentials/cards/session', t)).json()) as {
      sessionId: string;
      url: string;
      returning: boolean;
    };
  const poll = async (t: string, id: string) =>
    (await (await call('GET', `/api/credentials/cards/session?id=${id}`, t)).json()) as {
      status: string;
      cardSaved: boolean;
    };
  const users = async () =>
    (await new CredentialStore(kv.kv, 'test-credentials-key').get(WALLET)).agentcardUsers;

  it('lists nothing before a card is added', async () => {
    const res = await call('GET', '/api/credentials/cards', await token());
    expect(await res.json()).toEqual({ cards: [] });
  });

  it('adds a card through a vault session, then lists it', async () => {
    const t = await token();
    const s = await start(t);
    expect(s).toMatchObject({ sessionId: 'vs_1', returning: false });
    expect(s.url).toContain('vs_1');
    expect(await poll(t, s.sessionId)).toMatchObject({ status: 'pending', cardSaved: false });

    agentcard.finish(s.sessionId, 'usr_1');
    expect(await poll(t, s.sessionId)).toMatchObject({ status: 'linked', cardSaved: true });
    expect(await users()).toEqual(['usr_1']);

    const list = await call('GET', '/api/credentials/cards', t);
    expect(await list.json()).toEqual({
      cards: [{ id: 'vc_4242', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2029 }]
    });
  });

  it('is not saved yet when only the passkey step is done', async () => {
    const t = await token();
    const s = await start(t);
    agentcard.passkey(s.sessionId, 'usr_1');
    expect(await poll(t, s.sessionId)).toMatchObject({ status: 'linked', cardSaved: false });
  });

  it('signs a returning user with a contact in to the same vault user', async () => {
    const t = await token();
    const first = await start(t);
    agentcard.finish(first.sessionId, 'usr_1');
    await poll(t, first.sessionId);
    agentcard.withContact.add('usr_1');
    const again = await start(t);
    expect(again.returning).toBe(true);
    expect(agentcard.created.at(-1)).toEqual({ user_id: 'usr_1' });
  });

  it("falls back to an open session for a passkey-only user, and lists both users' cards", async () => {
    const t = await token();
    const first = await start(t);
    agentcard.finish(first.sessionId, 'usr_1');
    await poll(t, first.sessionId);

    const again = await start(t);
    expect(again.returning).toBe(false);
    expect(agentcard.created.at(-1)).toEqual({});
    agentcard.finish(again.sessionId, 'usr_2', '1881');
    await poll(t, again.sessionId);

    expect(await users()).toEqual(['usr_1', 'usr_2']);
    const list = (await (await call('GET', '/api/credentials/cards', t)).json()) as {
      cards: { last4: string }[];
    };
    expect(list.cards.map((c) => c.last4)).toEqual(['4242', '1881']);
  });

  it("won't finish another wallet's session", async () => {
    const t = await token();
    await start(t);
    const res = await call('GET', '/api/credentials/cards/session?id=vs_999', t);
    expect(res.status).toBe(404);
  });

  it('answers 503 when AgentCard is not configured', async () => {
    const res = await handleApi(
      req('GET', '/api/credentials/cards', { token: await token() }),
      env({ AGENTCARD_CLIENT_SECRET: undefined }),
      '/api/credentials/cards'
    );
    expect(res.status).toBe(503);
  });
});

describe('/api/credentials/buy', () => {
  const call = async (t: string, body: unknown) =>
    handleApi(
      req('POST', '/api/credentials/buy', { token: t, body }),
      env(),
      '/api/credentials/buy'
    );
  const connect = async (t: string) => {
    const s = (await (
      await handleApi(
        req('POST', '/api/credentials/cards/session', { token: t }),
        env(),
        '/api/credentials/cards/session'
      )
    ).json()) as { sessionId: string };
    agentcard.finish(s.sessionId, 'usr_1');
    await handleApi(
      req('GET', `/api/credentials/cards/session?id=${s.sessionId}`, { token: t }),
      env(),
      '/api/credentials/cards/session'
    );
  };

  it('asks for a card first', async () => {
    const res = await call(await token(), { ask: 'coffee' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/Connect a card/);
  });

  it('keeps the connection from a linked card session, sealed', async () => {
    await connect(await token());
    const rec = await new CredentialStore(kv.kv, 'test-credentials-key').get(WALLET);
    expect(rec.agentcardConnection).toMatchObject({ userId: 'usr_1', accessToken: 'act_usr_1' });
    expect([...kv.data.values()].join()).not.toContain('act_usr_1');
  });

  it('shops as the user, shipping to the saved address', async () => {
    const t = await token();
    await connect(t);
    await handleApi(
      req('PUT', '/api/credentials/address', {
        token: t,
        body: { ...ADDRESS, phone: '+15555550100' }
      }),
      env(),
      '/api/credentials/address'
    );
    const res = await call(t, { ask: 'a bag of coffee' });
    expect(await res.json()).toMatchObject({
      conversationId: 'conv_1',
      status: 'needs_input',
      cart: { totalCents: 675, hash: '0123456789abcdef' }
    });
    expect(agentcard.buys[0].auth).toBe('Bearer act_usr_1');
    expect(agentcard.buys[0].body).toMatchObject({
      ask: 'a bag of coffee',
      delivery_address: { street: ADDRESS.line1, zip: ADDRESS.zip, phone: '+15555550100' }
    });
  });

  it('confirms with the vault card and returns the approval link', async () => {
    const t = await token();
    await connect(t);
    const res = await call(t, { conversationId: 'conv_1', confirm: '0123456789abcdef' });
    expect(await res.json()).toMatchObject({
      status: 'declined',
      declineCode: 'vault_approval_required',
      approvalUrl: 'https://vault.test/authorize?id=cauth_1',
      chargeStatus: 'none'
    });
    expect(agentcard.buys[0].body).toMatchObject({
      conversation_id: 'conv_1',
      confirm: '0123456789abcdef',
      payment_source: 'vault'
    });
  });

  it('refreshes an expired connection and keeps the new pair', async () => {
    const t = await token();
    await connect(t);
    const db = new CredentialStore(kv.kv, 'test-credentials-key');
    await db.update(WALLET, (r) => ({
      ...r,
      agentcardConnection: { ...r.agentcardConnection!, expiresAt: Date.now() - 1 }
    }));
    await call(t, { ask: 'coffee' });
    expect(agentcard.refreshed).toEqual(['rct_1']);
    expect(agentcard.buys[0].auth).toBe('Bearer act_new');
    expect((await db.get(WALLET)).agentcardConnection).toMatchObject({ refreshToken: 'rct_2' });
  });

  it('validates the request', async () => {
    const t = await token();
    expect((await call(t, {})).status).toBe(400);
    expect((await call(t, { confirm: '0123456789abcdef' })).status).toBe(400);
    expect((await call(t, { conversationId: 'c', confirm: 'yes' })).status).toBe(400);
  });
});

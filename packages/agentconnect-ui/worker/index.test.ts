import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from './index.ts';

import { issueCertificate, resetJwksCache } from './agent-auth.ts';
import { AgentCard, resetAgentCardTokenCache } from './agentcard.ts';
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
import { decideApproval } from './services.ts';
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

  it('answers with an add-card link when no card is saved', async () => {
    const res = await call(await token(), { ask: 'coffee' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'requires_action',
      nextAction: { type: 'add_card', url: 'https://vault.test/v?vs=vs_1.sig', sessionId: 'vs_1' }
    });
    expect(agentcard.buys).toHaveLength(0);
  });

  it('keeps the connection from a linked card session, sealed', async () => {
    await connect(await token());
    const rec = await new CredentialStore(kv.kv, 'test-credentials-key').get(WALLET);
    expect(rec.agentcardConnection).toMatchObject({ userId: 'usr_1', accessToken: 'act_usr_1' });
    expect([...kv.data.values()].join()).not.toContain('act_usr_1');
  });

  const setLimit = async (t: string, cents: number) =>
    handleApi(
      req('PUT', '/api/credentials/settings', { token: t, body: { autoPayLimitCents: cents } }),
      env(),
      '/api/credentials/settings'
    );

  it('pays right away under the auto-pay limit, shipping to the saved address', async () => {
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
    expect(await res.json()).toMatchObject({ autoPay: true, conversationId: 'conv_1' });
    expect(agentcard.buys).toHaveLength(2);
    expect(agentcard.buys[0].auth).toBe('Bearer act_usr_1');
    expect(agentcard.buys[0].body).toMatchObject({
      ask: 'a bag of coffee',
      delivery_address: { street: ADDRESS.line1, zip: ADDRESS.zip, phone: '+15555550100' }
    });
    expect(agentcard.buys[1].body).toMatchObject({
      conversation_id: 'conv_1',
      confirm: '0123456789abcdef',
      payment_source: 'vault'
    });
  });

  it('waits for the owner over the limit, and places the cart once they approve', async () => {
    const t = await token();
    await connect(t);
    await setLimit(t, 500);
    const pending = (await (await call(t, { ask: 'a bag of coffee' })).json()) as {
      status: string;
      approvalId: string;
      approvalUrl: string;
    };
    expect(pending.status).toBe('pending_approval');
    expect(pending.approvalUrl).toBe(`https://agentconnect.test/approve?r=${pending.approvalId}`);
    expect(agentcard.buys).toHaveLength(1);

    const db = new CredentialStore(kv.kv, 'test-credentials-key');
    const cards = new AgentCard({ clientId: 'client', clientSecret: 'acs_secret' });
    await expect(
      decideApproval(
        db,
        cards,
        pending.approvalId,
        '0x00000000000000000000000000000000000000bb',
        true
      )
    ).rejects.toThrow(/another account/);
    expect(await decideApproval(db, cards, pending.approvalId, WALLET, true)).toEqual({
      status: 'awaiting_passkey',
      passkeyUrl: 'https://vault.test/authorize?id=cauth_1'
    });
    expect(agentcard.buys[1].body).toMatchObject({
      confirm: '0123456789abcdef',
      payment_source: 'vault'
    });

    const status = await handleApi(
      req('GET', `/api/credentials/approvals/${pending.approvalId}`, { token: t }),
      env(),
      `/api/credentials/approvals/${pending.approvalId}`
    );
    expect(await status.json()).toMatchObject({ status: 'awaiting_passkey' });
  });

  it('places an approved cart once, even when Approve is pressed twice at once', async () => {
    const t = await token();
    await connect(t);
    await setLimit(t, 500);
    const { approvalId } = (await (await call(t, { ask: 'a bag of coffee' })).json()) as {
      approvalId: string;
    };
    const db = new CredentialStore(kv.kv, 'test-credentials-key');
    const cards = new AgentCard({ clientId: 'client', clientSecret: 'acs_secret' });
    const [first, second] = await Promise.all([
      decideApproval(db, cards, approvalId, WALLET, true),
      decideApproval(db, cards, approvalId, WALLET, true)
    ]);
    expect(first).toEqual(second);
    // One search, one confirm: the cart was placed once.
    expect(agentcard.buys.filter((b) => b.body.confirm)).toHaveLength(1);
  });

  it('leaves the cart alone when another worker already claimed the decision', async () => {
    const t = await token();
    await connect(t);
    await setLimit(t, 500);
    const { approvalId } = (await (await call(t, { ask: 'a bag of coffee' })).json()) as {
      approvalId: string;
    };
    const db = new CredentialStore(kv.kv, 'test-credentials-key');
    const cards = new AgentCard({ clientId: 'client', clientSecret: 'acs_secret' });
    const taken = { claim: async () => false };
    expect(await decideApproval(db, cards, approvalId, WALLET, true, taken)).toEqual({
      status: 'pending'
    });
    expect(agentcard.buys.filter((b) => b.body.confirm)).toHaveLength(0);
  });

  it('records a declined approval and places nothing', async () => {
    const t = await token();
    await connect(t);
    await setLimit(t, 0);
    const { approvalId } = (await (await call(t, { ask: 'coffee' })).json()) as {
      approvalId: string;
    };
    const db = new CredentialStore(kv.kv, 'test-credentials-key');
    const cards = new AgentCard({ clientId: 'client', clientSecret: 'acs_secret' });
    expect(await decideApproval(db, cards, approvalId, WALLET, false)).toEqual({
      status: 'declined'
    });
    expect(agentcard.buys).toHaveLength(1);
  });

  it("authorizes a checkout in the agent's browser by the limit", async () => {
    const t = await token();
    const checkout = (totalCents: number) =>
      handleApi(
        req('POST', '/api/credentials/checkout', {
          token: t,
          body: {
            merchant: 'IKEA',
            merchantUrl: 'https://www.ikea.com/us/en/',
            totalCents,
            items: [{ name: 'LISABO table', qty: 1 }]
          }
        }),
        env(),
        '/api/credentials/checkout'
      );
    expect(await (await checkout(1999)).json()).toMatchObject({
      status: 'approved',
      autoApproved: true
    });
    const over = (await (await checkout(14999)).json()) as { status: string; approvalId: string };
    expect(over.status).toBe('pending_approval');
    const db = new CredentialStore(kv.kv, 'test-credentials-key');
    const cards = new AgentCard({ clientId: 'client', clientSecret: 'acs_secret' });
    expect(await decideApproval(db, cards, over.approvalId, WALLET, true)).toEqual({
      status: 'approved'
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
    expect((await setLimit(t, -1)).status).toBe(400);
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

  it('skips sign-in for an owner signed in on the site, showing the auto-pay limit', async () => {
    const { e, signIn, completed } = setup();
    const c = await signIn.create({ authRequest: authRequest as never, clientName: 'Claude Code' });
    const res = await call(e, 'GET', `/api/connect?c=${c}`, { cookie: await cookie() });
    expect(await res.json()).toEqual({
      clientName: 'Claude Code',
      signedIn: true,
      email: 'owner@example.com',
      autoPayLimitCents: 10_000,
      confirmsEachPurchase: false,
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
    const res = await call(e, 'GET', `/api/connect?c=${c}`, { cookie: await cookie() });
    expect(await res.json()).toMatchObject({ confirmsEachPurchase: true });
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

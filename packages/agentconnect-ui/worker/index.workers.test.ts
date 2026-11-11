import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { issueSession, SESSION_COOKIE } from './owner-session.ts';
import { OwnerSignIn } from './owner-signin.ts';
import { SealedKv } from './store.ts';

const SITE = 'https://agentconnect.test';
const WALLET = `0x${'ab'.repeat(20)}`;
const KEY_ID = 'a'.repeat(32);
const TEST_PUBLISHABLE_KEY = 'pk_sdbx_testproject_testkey';

const control = (path: string, init?: RequestInit) =>
  fetch(`https://fake-control.test${path}`, init);

async function sessionCookie(wallet = WALLET) {
  const token = await issueSession({ wallet, email: null }, env.AGENT_CERT_SECRET);
  return `${SESSION_COOKIE}=${token}`;
}

async function keyOp(body: Record<string, unknown>) {
  const stub = env.AGENT_KEYS.get(env.AGENT_KEYS.idFromName(KEY_ID));
  const res = await stub.fetch('https://agent-key/', {
    method: 'POST',
    body: JSON.stringify(body)
  });
  return (await res.json()) as { ok: boolean; value?: Record<string, unknown> };
}

beforeEach(async () => {
  await control('/reset', { method: 'POST' });
});

describe('worker routes in the Workers runtime', { timeout: 30_000 }, () => {
  it('serves OAuth metadata without any outbound call', async () => {
    const res = await SELF.fetch(`${SITE}/.well-known/oauth-authorization-server`);
    expect(res.status).equal(200);
    expect(await res.json()).property('authorization_endpoint', `${SITE}/authorize`);
    expect(await (await control('/log')).json()).deep.equal([]);
  });

  it("refuses unknown hosts in the test runtime's outbound handler", async () => {
    expect((await fetch('https://unlisted.test/')).status).equal(599);
    const log = (await (await control('/log')).json()) as { host: string; faked: boolean }[];
    expect(log.map((c) => [c.host, c.faked])).deep.equal([['unlisted.test', false]]);
  });

  it('lets only the signed-in owner, from this site, answer an approval', async () => {
    await keyOp({ op: 'register', wallet: WALLET, days: 1, appName: 'tests' });
    const proposed = await keyOp({
      op: 'propose',
      wallet: WALLET,
      appName: 'tests',
      request: { op: 'pay_service', url: 'https://service.x402.test/data', maxUsd: '1' }
    });
    const url = `${SITE}/api/actions/${KEY_ID}/${proposed.value?.actionId}`;
    const pending = async () =>
      (await keyOp({ op: 'action', wallet: WALLET, id: String(proposed.value?.actionId) })).value;
    const cookie = await sessionCookie();
    const decline = JSON.stringify({ approve: false });

    expect((await SELF.fetch(url)).status).equal(401);
    expect((await SELF.fetch(url, { method: 'POST', body: decline })).status).equal(401);
    expect(await pending()).property('status', 'pending');

    const view = await SELF.fetch(url, { headers: { cookie } });
    expect(view.status).equal(200);
    expect(await view.json()).property('status', 'pending');

    const noOrigin = await SELF.fetch(url, { method: 'POST', headers: { cookie }, body: decline });
    expect(noOrigin.status).equal(401);
    expect(await pending()).property('status', 'pending');

    const otherSite = await SELF.fetch(url, {
      method: 'POST',
      headers: { cookie, origin: 'https://elsewhere.test' },
      body: decline
    });
    expect(otherSite.status).equal(401);
    expect(await pending()).property('status', 'pending');

    const done = await SELF.fetch(url, {
      method: 'POST',
      headers: { cookie, origin: SITE },
      body: decline
    });
    expect(done.status).equal(200);
    expect(await done.json()).property('status', 'declined');
  });

  it('sends a denied connection back to the agent with its state, and only for the signed-in owner', async () => {
    const registered = await SELF.fetch(`${SITE}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['http://localhost:9/cb'],
        client_name: 'tests',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code']
      })
    });
    expect(registered.status).equal(201);
    const { client_id: clientId } = (await registered.json()) as { client_id: string };

    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'http://localhost:9/cb',
      state: 'state-1',
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256'
    });
    const authorize = await SELF.fetch(`${SITE}/authorize?${query}`, { redirect: 'manual' });
    expect(authorize.status).equal(302);
    const connectId = new URL(authorize.headers.get('location') ?? '').searchParams.get('c') ?? '';
    expect(connectId).match(/^[0-9a-f]{32}$/);

    const signIn = new OwnerSignIn(
      new SealedKv(env.OAUTH_KV, env.CREDENTIALS_KEY),
      TEST_PUBLISHABLE_KEY
    );
    await signIn.markSignedIn(connectId, { wallet: WALLET, email: null });
    const deny = JSON.stringify({ c: connectId, allow: false });

    const anonymous = await SELF.fetch(`${SITE}/api/connect/decide`, {
      method: 'POST',
      body: deny
    });
    expect(anonymous.status).equal(401);

    const someoneElse = await SELF.fetch(`${SITE}/api/connect/decide`, {
      method: 'POST',
      headers: { cookie: await sessionCookie(`0x${'cd'.repeat(20)}`), origin: SITE },
      body: deny
    });
    expect(someoneElse.status).equal(401);

    const owner = await SELF.fetch(`${SITE}/api/connect/decide`, {
      method: 'POST',
      headers: { cookie: await sessionCookie(), origin: SITE },
      body: deny
    });
    expect(owner.status).equal(200);
    const { redirectTo } = (await owner.json()) as { redirectTo: string };
    const back = new URL(redirectTo);
    expect(back.origin + back.pathname).equal('http://localhost:9/cb');
    expect(back.searchParams.get('error')).equal('access_denied');
    expect(back.searchParams.get('state')).equal('state-1');
  });
});

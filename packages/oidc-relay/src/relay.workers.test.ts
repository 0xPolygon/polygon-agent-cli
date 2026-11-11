import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const base = 'https://relay.test';

// Session ids are unique per test: the Durable Object namespace is shared across a file.
let counter = 0;
const newSession = (): string => `workers-test-session-${String(++counter).padStart(4, '0')}`;

const post = (path: string, body: unknown): Promise<Response> =>
  SELF.fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) });
const register = (session: string, context?: unknown): Promise<Response> =>
  post('/api/login/register', { session, context });
const getStatus = (session: string): Promise<Response> =>
  SELF.fetch(`${base}/api/login/status?session=${session}`);
const nextAction = (session: string): Promise<Response> =>
  SELF.fetch(`${base}/api/login/next-action?session=${session}`);

describe('relay in the Workers runtime', { timeout: 10_000 }, () => {
  it('serves /health and answers preflight, both with CORS', async () => {
    const health = await SELF.fetch(`${base}/health`);
    expect(health.status).equal(200);
    expect(health.headers.get('access-control-allow-origin')).equal('*');
    expect(await health.json()).deep.equal({ ok: true, service: 'oidc-relay' });

    const preflight = await SELF.fetch(`${base}/api/login/action`, { method: 'OPTIONS' });
    expect(preflight.status).equal(204);
    expect(preflight.headers.get('access-control-allow-headers')).equal('Content-Type');
  });

  it('returns 404 for an unknown path', async () => {
    const res = await SELF.fetch(`${base}/nope`);
    expect(res.status).equal(404);
    expect(await res.text()).equal('not found');
  });

  it('rejects bad input at the HTTP edge with CORS on the error', async () => {
    const session = newSession();
    const badJson = await SELF.fetch(`${base}/api/login/register`, {
      method: 'POST',
      body: '{'
    });
    expect(badJson.status).equal(400);
    expect(badJson.headers.get('access-control-allow-origin')).equal('*');
    expect(await badJson.json()).deep.equal({ error: 'invalid json' });

    expect((await register('short')).status).equal(400);
    expect((await nextAction('bad id!')).status).equal(400);
    const badStatusId = await getStatus('bad id!');
    expect(badStatusId.status).equal(400);
    expect(await badStatusId.json()).property('status', 'error');

    expect((await post('/api/login/action', { session, action: { type: 'nope' } })).status).equal(
      400
    );
    const foreignCallback = {
      type: 'oidc-callback',
      callbackUrl: 'https://other.example/login#x'
    };
    expect((await post('/api/login/action', { session, action: foreignCallback })).status).equal(
      400
    );
    expect(
      (await post('/api/login/status', { session, status: { status: 'bogus' } })).status
    ).equal(400);
  });

  it('keeps sessions apart and drops an invalid context instead of failing', async () => {
    const a = newSession();
    const b = newSession();
    expect((await register(a, { purpose: 'allowance', allowanceUsd: 5 })).status).equal(204);
    expect((await register(b, { purpose: 'nonsense' })).status).equal(204);

    expect(await (await getStatus(a)).json()).deep.equal({
      status: 'awaiting-method',
      context: { purpose: 'allowance', allowanceUsd: 5 }
    });
    expect(await (await getStatus(b)).json()).deep.equal({ status: 'awaiting-method' });

    const c = newSession();
    expect(await (await getStatus(c)).json()).deep.equal({ status: 'expired' });
    expect(
      (await post('/api/login/action', { session: c, action: { type: 'google' } })).status
    ).equal(410);

    await post('/api/login/action', { session: a, action: { type: 'google' } });
    expect(await (await nextAction(b)).json()).deep.equal({ state: 'pending' });
  });

  it('hands an action over once, then refuses actions after the login finishes', async () => {
    const session = newSession();
    const before = await post('/api/login/action', { session, action: { type: 'cancel' } });
    expect(before.status).equal(410);
    expect(await before.json()).deep.equal({ error: 'expired' });

    await register(session);
    const submitted = await post('/api/login/action', {
      session,
      action: { type: 'otp', code: '123456' }
    });
    expect(submitted.status).equal(204);

    expect(await (await nextAction(session)).json()).deep.equal({
      state: 'action',
      action: { type: 'otp', code: '123456' }
    });
    expect(await (await nextAction(session)).json()).deep.equal({ state: 'pending' });

    const done = await post('/api/login/status', {
      session,
      status: { status: 'done', walletAddress: '0x0000000000000000000000000000000000000001' }
    });
    expect(done.status).equal(204);
    expect(await (await getStatus(session)).json()).property('status', 'done');

    const after = await post('/api/login/action', { session, action: { type: 'google' } });
    expect(after.status).equal(410);
    expect(await after.json()).deep.equal({ error: 'finished' });
  });

  it('clears the session when its expiry alarm fires', async () => {
    const session = newSession();
    await register(session);
    await post('/api/login/action', { session, action: { type: 'google' } });
    const stub = env.LOGIN_SESSION.get(env.LOGIN_SESSION.idFromName(session));

    const alarmAt = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarmAt).a('number');
    expect(Number(alarmAt) - Date.now()).within(590_000, 600_000);

    expect(await runDurableObjectAlarm(stub)).equal(true);
    expect(await (await getStatus(session)).json()).deep.equal({ status: 'expired' });
    const keys = await runInDurableObject(stub, (_instance, state) => state.storage.list());
    expect(keys.size).equal(0);
    expect(await runDurableObjectAlarm(stub)).equal(false);
  });
});

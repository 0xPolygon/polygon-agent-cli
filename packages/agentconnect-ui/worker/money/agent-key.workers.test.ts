import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

interface KeyReply {
  ok: boolean;
  value?: unknown;
  error?: { code: string };
}
interface Recorded {
  host: string;
  path: string;
  body: string | null;
}

const WALLET = `0x${'ab'.repeat(20)}`;
const OTHER_WALLET = `0x${'cd'.repeat(20)}`;
const WALLET_SERVICE = 'sandbox-api.polygon.technology';

let counter = 0;
const freshName = () => `key-${(counter += 1)}`;

const control = (path: string, init?: RequestInit) =>
  fetch(`https://fake-control.test${path}`, init);
const readLog = async () => (await (await control('/log')).json()) as Recorded[];
const stubOf = (name: string) => env.AGENT_KEYS.get(env.AGENT_KEYS.idFromName(name));

async function op(name: string, body: Record<string, unknown>): Promise<KeyReply> {
  const res = await stubOf(name).fetch('https://agent-key/', {
    method: 'POST',
    body: JSON.stringify(body)
  });
  return (await res.json()) as KeyReply;
}

const stored = (name: string, key: string) =>
  runInDurableObject(stubOf(name), (_instance, state) => state.storage.get(key));
const storedKeys = (name: string) =>
  runInDurableObject(stubOf(name), async (_instance, state) => [
    ...(await state.storage.list()).keys()
  ]);

const register = (name: string) =>
  op(name, { op: 'register', wallet: WALLET, days: 1, appName: 'tests' });

beforeEach(async () => {
  await control('/reset', { method: 'POST' });
});

describe('a connection key in a real Durable Object', { timeout: 30_000 }, () => {
  it('seals its key once and refuses to replace it or serve another wallet', async () => {
    const name = freshName();
    expect((await register(name)).ok).equal(true);
    const sealed = await stored(name, 'key');
    expect(sealed).a('string');
    expect(sealed).match(/^v1\./);
    expect(sealed).not.match(/^[0-9a-f]{64}$/);

    const again = await register(name);
    expect(again.ok).equal(false);
    expect(again.error).property('code', 'invalid_input');
    expect((await stored(name, 'key')) === sealed).equal(true);

    const other = await op(name, { op: 'status', wallet: OTHER_WALLET });
    expect(other.error).property('code', 'not_connected');
  });

  it('forgets everything when the wallet service confirms the revoke', async () => {
    const name = freshName();
    await register(name);
    const revoked = await op(name, { op: 'revoke', wallet: WALLET });
    expect(revoked.value).property('revoked', true);
    expect(await storedKeys(name)).length(0);
    const after = await op(name, { op: 'status', wallet: WALLET });
    expect(after.error).property('code', 'not_connected');
    const revokeCall = (await readLog()).find((c) => c.path === '/v1/Waas/RevokeCredential');
    expect(revokeCall).property('body', JSON.stringify({ credentialId: 'cred-test-1' }));
  });

  it('keeps the key when the wallet service refuses the revoke', async () => {
    const name = freshName();
    await register(name);
    await control('/scenario', {
      method: 'POST',
      body: JSON.stringify({ host: WALLET_SERVICE, scenario: { revokeStatus: 500 } })
    });
    const revoked = await op(name, { op: 'revoke', wallet: WALLET });
    expect(revoked.value).property('revoked', false);
    expect(await storedKeys(name)).include.members(['key', 'record']);
  });

  it('forgets the key when the wallet service says it no longer accepts it', async () => {
    const name = freshName();
    await register(name);
    await control('/scenario', {
      method: 'POST',
      body: JSON.stringify({ host: WALLET_SERVICE, scenario: { revokeStatus: 401 } })
    });
    const revoked = await op(name, { op: 'revoke', wallet: WALLET });
    expect(revoked.value).property('revoked', true);
    expect(await storedKeys(name)).length(0);
  });

  it('keeps wallet store entries first-wins, leases exclusive and objects separate', async () => {
    const store = `wallet:${WALLET}`;
    const first = await op(store, { op: 'wstore_put_new', name: 'account', value: 'one' });
    const second = await op(store, { op: 'wstore_put_new', name: 'account', value: 'two' });
    expect(first.value).equal('one');
    expect(second.value).equal('one');

    const until = Date.now() + 60_000;
    expect((await op(store, { op: 'wstore_lease', holder: 'a', until })).value).equal(true);
    expect((await op(store, { op: 'wstore_lease', holder: 'b', until })).value).equal(false);
    await op(store, { op: 'wstore_release', holder: 'a' });
    expect((await op(store, { op: 'wstore_lease', holder: 'b', until })).value).equal(true);

    const elsewhere = await op(`wallet:${OTHER_WALLET}`, { op: 'wstore_get', name: 'account' });
    expect(elsewhere.value).equal(null);
  });

  it('declines an approval for good and never runs it', async () => {
    const name = freshName();
    await register(name);
    const proposed = await op(name, {
      op: 'propose',
      wallet: WALLET,
      appName: 'tests',
      request: { op: 'pay_service', url: 'https://service.x402.test/data', maxUsd: '1' }
    });
    const { actionId } = proposed.value as { actionId: string };
    expect(proposed.value).property('status', 'pending');

    const declined = await op(name, { op: 'decide', wallet: WALLET, id: actionId, approve: false });
    expect(declined.value).property('status', 'declined');
    const again = await op(name, { op: 'decide', wallet: WALLET, id: actionId, approve: true });
    expect(again.ok).equal(false);
    expect(again.error).property('code', 'invalid_input');
    const view = await op(name, { op: 'action', wallet: WALLET, id: actionId });
    expect(view.value).property('status', 'declined');

    const paths = (await readLog()).map((c) => c.path);
    expect(paths).deep.equal(['/v1/Waas/RegisterCredential']);
  });
});

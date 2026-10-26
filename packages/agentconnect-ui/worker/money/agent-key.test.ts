import { describe, expect, it } from 'vitest';

import type { RemoteAccessClient } from '@polygonlabs/oms-wallet';

import type { KeyRecord, KeyRequest, KeyResponse, KeyStorage } from './agent-key.ts';

import { proposeAction } from './actions.ts';
import { AgentKey } from './agent-key.ts';
import { buildPlan, planToJson } from './plan.ts';
import { httpError, PRICES, START, WALLET } from './test-fakes.ts';

const OWNER = WALLET.toLowerCase();

function memoryStorage(): KeyStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T>(k: string) => data.get(k) as T | undefined,
    put: async (k, v) => void data.set(k, structuredClone(v)),
    list: async <T>({ prefix }: { prefix: string }) =>
      new Map([...data].filter(([k]) => k.startsWith(prefix))) as Map<string, T>,
    deleteAll: async () => data.clear()
  };
}

function setup(client: Partial<RemoteAccessClient> = {}) {
  const storage = memoryStorage();
  const key = new AgentKey(
    { storage },
    { CREDENTIALS_KEY: 'test-secret-test-secret-test-secret', OMS_PUBLISHABLE_KEY: 'pk_test' }
  );
  const calls: string[] = [];
  key.now = () => START;
  key.clientFor = () =>
    ({
      registerCredential: async () => {
        calls.push('register');
        return { credentialId: 'cred-1' };
      },
      revokeCredential: async () => void calls.push('revoke'),
      listSessions: async () => [],
      ...client
    }) as unknown as RemoteAccessClient;
  const ask = async (req: KeyRequest) =>
    (await (
      await key.fetch(
        new Request('https://agent-key/', { method: 'POST', body: JSON.stringify(req) })
      )
    ).json()) as KeyResponse;
  return { storage, ask, calls };
}

describe('AgentKey', () => {
  it('registers a sealed key for the wallet, once', async () => {
    const { storage, ask, calls } = setup();
    const res = await ask({ op: 'register', wallet: WALLET, days: 30, appName: 'Claude' });
    expect(res).toMatchObject({ ok: true, value: { wallet: OWNER, credentialId: 'cred-1' } });
    const record = (res as { value: KeyRecord }).value;
    // 30 days and a day's margin.
    expect(Date.parse(record.expiresAt) - START.getTime()).toBe(31 * 86_400_000);
    // The private key is never stored in the clear.
    const sealed = storage.data.get('key') as string;
    expect(sealed).toMatch(/^v1\./);
    expect(calls).toEqual(['register']);

    expect(
      await ask({ op: 'register', wallet: WALLET, days: 30, appName: 'Claude' })
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' }
    });
  });

  it('refuses requests for any other wallet', async () => {
    const { ask } = setup();
    await ask({ op: 'register', wallet: WALLET, days: 30, appName: 'Claude' });
    expect(
      await ask({ op: 'status', wallet: '0x00000000000000000000000000000000000000ee' })
    ).toMatchObject({ ok: false, error: { code: 'not_connected' } });
  });

  it('keeps only sessions that match the plan', async () => {
    const plan = buildPlan({
      allowanceUsd: 100,
      days: 30,
      heldChainIds: [],
      prices: PRICES,
      now: START
    });
    const polygon = plan.chains[0];
    const { storage, ask } = setup({
      listSessions: async () => [
        {
          sessionId: 's-137',
          walletId: 'w-1',
          signerAddress: WALLET,
          chainId: 137,
          expiresAt: plan.expiresAt,
          grants: polygon.grants.map((g) => ({
            kind: 'erc20Transfer' as const,
            token: g.token,
            limit: g.limit,
            cumulative: true
          }))
        },
        // Base came back with a different limit.
        {
          sessionId: 's-8453',
          walletId: 'w-1',
          signerAddress: WALLET,
          chainId: 8453,
          expiresAt: plan.expiresAt,
          grants: plan.chains[1].grants.map((g) => ({
            kind: 'erc20Transfer' as const,
            token: g.token,
            limit: g.limit * 2n,
            cumulative: true
          }))
        }
      ],
      prepareTransaction: async () =>
        ({ txnId: 't', status: 'quoted', feeOptions: [], sponsored: true, expiresAt: '' }) as never
    });
    await ask({ op: 'register', wallet: WALLET, days: 30, appName: 'Claude' });
    const res = await ask({
      op: 'approve',
      wallet: WALLET,
      plan: planToJson(plan),
      approved: [
        { chainId: 137, sessionId: 's-137', walletId: 'w-1' },
        { chainId: 8453, sessionId: 's-8453', walletId: 'w-1' }
      ]
    });
    expect(res).toMatchObject({
      ok: true,
      value: {
        kept: [{ chainId: 137 }],
        dropped: [{ chainId: 8453 }]
      }
    });
    const approved = storage.data.get('approved') as { plan: { chains: { chainId: number }[] } };
    expect(approved.plan.chains.map((c) => c.chainId)).toEqual([137]);
  });

  it('forgets everything once the key is revoked, and counts a refused key as revoked', async () => {
    const first = setup();
    await first.ask({ op: 'register', wallet: WALLET, days: 30, appName: 'Claude' });
    expect(await first.ask({ op: 'revoke', wallet: WALLET })).toEqual({
      ok: true,
      value: { revoked: true }
    });
    expect(first.storage.data.size).toBe(0);

    const second = setup({
      revokeCredential: async () => {
        throw httpError(401);
      }
    });
    await second.ask({ op: 'register', wallet: WALLET, days: 30, appName: 'Claude' });
    expect(await second.ask({ op: 'revoke', wallet: WALLET })).toMatchObject({
      value: { revoked: true }
    });
  });

  it('runs one request at a time', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { ask } = setup({
      registerCredential: async () => {
        order.push('register start');
        await gate;
        order.push('register end');
        return { credentialId: 'cred-1' };
      }
    });
    const registering = ask({ op: 'register', wallet: WALLET, days: 30, appName: 'Claude' });
    const status = ask({ op: 'status', wallet: WALLET }).then((r) => {
      order.push('status');
      return r;
    });
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([registering, status]);
    expect(order).toEqual(['register start', 'register end', 'status']);
  });

  describe("the wallet's object", () => {
    const store = () => setup();
    const raw = async (s: ReturnType<typeof store>, req: object) =>
      (await (
        await new AgentKey(
          { storage: s.storage },
          { CREDENTIALS_KEY: 'test-secret-test-secret-test-secret' }
        ).fetch(new Request('https://agent-key/', { method: 'POST', body: JSON.stringify(req) }))
      ).json()) as KeyResponse;

    it('keeps the first value put_new stores', async () => {
      const s = store();
      expect(await raw(s, { op: 'wstore_put_new', name: 'pm-key', value: 'a' })).toEqual({
        ok: true,
        value: 'a'
      });
      expect(await raw(s, { op: 'wstore_put_new', name: 'pm-key', value: 'b' })).toEqual({
        ok: true,
        value: 'a'
      });
      expect(await raw(s, { op: 'wstore_get', name: 'pm-key' })).toEqual({ ok: true, value: 'a' });
    });

    it('leases to one holder at a time until it lapses or is released', async () => {
      const s = store();
      // This object keeps the real clock.
      const later = Date.now() + 60_000;
      const lease = (holder: string, until = later) =>
        raw(s, { op: 'wstore_lease', holder, until });
      expect(await lease('one')).toEqual({ ok: true, value: true });
      expect(await lease('two')).toEqual({ ok: true, value: false });
      await raw(s, { op: 'wstore_release', holder: 'one' });
      expect(await lease('two')).toEqual({ ok: true, value: true });
    });

    it("isn't answered by a connection's object", async () => {
      const s = store();
      await s.ask({ op: 'register', wallet: WALLET, days: 30, appName: 'Claude' });
      expect(await raw(s, { op: 'wstore_get', name: 'pm-key' })).toMatchObject({ ok: false });
    });
  });

  describe("the owner's kept sign-in", () => {
    const snapshot = { key: 'ab'.repeat(32), storage: { session: 'x' } };

    async function connected(listWallets: () => Promise<unknown>) {
      const storage = memoryStorage();
      const key = new AgentKey(
        { storage },
        { CREDENTIALS_KEY: 'test-secret-test-secret-test-secret', OMS_PUBLISHABLE_KEY: 'pk_test' }
      );
      key.now = () => START;
      key.clientFor = () =>
        ({
          registerCredential: async () => ({ credentialId: 'cred-1' }),
          revokeCredential: async () => {},
          listSessions: async () => []
        }) as unknown as RemoteAccessClient;
      const sent: string[] = [];
      let signedOut = false;
      key.ownerOms = () =>
        ({
          wallet: {
            listWallets: async () => {
              await listWallets();
              return [{ id: 'w1', address: WALLET, keyOrigin: 'generated' }];
            },
            walletAddress: WALLET,
            useWallet: async () => {},
            sendTransaction: async (tx: { to: string }) => {
              sent.push(tx.to);
              return { txnHash: '0xhash' };
            },
            signOut: async () => void (signedOut = true)
          }
        }) as never;
      const ask = async (req: KeyRequest) =>
        (await (
          await key.fetch(
            new Request('https://agent-key/', { method: 'POST', body: JSON.stringify(req) })
          )
        ).json()) as KeyResponse;
      await ask({ op: 'register', wallet: WALLET, days: 30, appName: 'Claude' });
      const action = await proposeAction({
        storage,
        request: { op: 'earn_withdraw' },
        title: 'Withdraw 1 USDC from a vault',
        details: [],
        appName: 'Claude',
        owner: {
          chainId: 137,
          transactions: [{ to: '0x00000000000000000000000000000000000000f1', data: '0x' }]
        },
        now: START
      });
      return { storage, ask, sent, signedOut: () => signedOut, id: action.id };
    }

    it('approves an owner action with one click while it holds', async () => {
      const c = await connected(async () => {});
      expect(await c.ask({ op: 'action', wallet: WALLET, id: c.id })).toMatchObject({
        value: { ownerSignIn: true }
      });
      await c.ask({ op: 'keep_owner', wallet: WALLET, snapshot });
      // Sealed, never in the clear.
      expect(c.storage.data.get('owner-session')).toMatch(/^v1\./);
      expect(await c.ask({ op: 'action', wallet: WALLET, id: c.id })).toMatchObject({
        value: { ownerSignIn: false }
      });
      expect(await c.ask({ op: 'owner_run', wallet: WALLET, id: c.id })).toMatchObject({
        ok: true,
        value: { status: 'done', result: { txHashes: ['0xhash'] } }
      });
      expect(c.sent).toEqual(['0x00000000000000000000000000000000000000f1']);
      // Run once only.
      expect(await c.ask({ op: 'owner_run', wallet: WALLET, id: c.id })).toMatchObject({
        ok: false
      });
    });

    it('asks for a sign-in, and runs nothing, once it has run out', async () => {
      const c = await connected(async () => {
        throw httpError(401);
      });
      await c.ask({ op: 'keep_owner', wallet: WALLET, snapshot });
      expect(await c.ask({ op: 'owner_run', wallet: WALLET, id: c.id })).toMatchObject({
        ok: false,
        error: { code: 'owner_signin_needed' }
      });
      expect(c.sent).toEqual([]);
      expect(await c.ask({ op: 'action', wallet: WALLET, id: c.id })).toMatchObject({
        value: { status: 'pending', ownerSignIn: true }
      });
    });

    it('signs out at OMS when the connection is revoked', async () => {
      const c = await connected(async () => {});
      await c.ask({ op: 'keep_owner', wallet: WALLET, snapshot });
      await c.ask({ op: 'revoke', wallet: WALLET });
      expect(c.signedOut()).toBe(true);
      expect(c.storage.data.size).toBe(0);
    });
  });
});

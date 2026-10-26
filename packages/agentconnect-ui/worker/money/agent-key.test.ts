import { describe, expect, it } from 'vitest';

import type { RemoteAccessClient } from '@polygonlabs/oms-wallet';

import type { KeyRecord, KeyRequest, KeyResponse, KeyStorage } from './agent-key.ts';

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
});

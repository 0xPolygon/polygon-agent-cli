import { describe, expect, it } from 'vitest';

import type { KeyRequest, KeyResponse } from './agent-key.ts';
import type { AllowanceDeps } from './connect.ts';
import type { PlanJson } from './plan.ts';

import { setUpAllowance } from './connect.ts';
import { MoneyError } from './errors.ts';
import { PRICES, START, WALLET } from './test-fakes.ts';

function setup(opts: { failChain?: number; drop?: number[] } = {}) {
  const asked: KeyRequest[] = [];
  const revoked: { credentialId: string; sessionId?: string }[] = [];
  const authorized: { chainId: number; expiresAt: string; grants: number }[] = [];
  const deps: AllowanceDeps = {
    owner: {
      authorizeRemoteAccess: async (p) => {
        if (p.network.id === opts.failChain) throw new Error('nope');
        authorized.push({ chainId: p.network.id, expiresAt: p.expiresAt, grants: p.grants.length });
        return { sessionId: `s-${p.network.id}`, walletId: 'w-1' } as never;
      },
      revokeAccess: async (p) => void revoked.push(p)
    },
    indexer: {
      // Holds USDC on Arbitrum, so Arbitrum is covered too.
      getBalances: async () =>
        ({
          balances: [
            {
              chainId: 42161,
              contractAddress: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
              balance: '5000000'
            }
          ]
        }) as never
    },
    prices: async () =>
      new Map([
        ...PRICES,
        ['42161:0x82af49447d8a07e3bd95bd0d56f35241523fbab1', 2500],
        ['42161:0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f', 60_000],
        ['42161:0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', 60_000]
      ]),
    key: async (req): Promise<KeyResponse> => {
      asked.push(req);
      if (req.op === 'register') {
        return {
          ok: true,
          value: { wallet: WALLET, credentialId: 'cred-1', registeredAt: '', expiresAt: '' }
        };
      }
      if (req.op === 'approve') {
        const drop = opts.drop ?? [];
        return {
          ok: true,
          value: {
            kept: req.approved.filter((a) => !drop.includes(a.chainId)),
            dropped: req.approved
              .filter((a) => drop.includes(a.chainId))
              .map((a) => ({ chainId: a.chainId, reason: "didn't match" }))
          }
        };
      }
      return { ok: true, value: { revoked: true } };
    },
    now: () => START
  };
  return { deps, asked, revoked, authorized };
}

describe('setUpAllowance', () => {
  it('approves the plan on Polygon, Base and chains the wallet holds tokens on', async () => {
    const { deps, asked, authorized } = setup();
    const result = await setUpAllowance({
      wallet: WALLET,
      appName: 'Claude',
      allowanceUsd: 500,
      days: 7,
      deps
    });
    expect(result).toMatchObject({
      allowanceUsd: 500,
      days: 7,
      chains: ['Polygon', 'Base', 'Arbitrum'],
      skipped: []
    });
    expect(authorized.map((a) => a.chainId)).toEqual([137, 8453, 42161]);
    expect(new Set(authorized.map((a) => a.expiresAt))).toEqual(
      new Set([new Date(START.getTime() + 7 * 86_400_000).toISOString()])
    );
    expect(asked[0]).toEqual({ op: 'register', wallet: WALLET, days: 7, appName: 'Claude' });
    const approve = asked[1] as { plan: PlanJson };
    // USDC on Polygon: $500 at $1, in 6 decimals.
    expect(approve.plan.chains[0].grants[0]).toMatchObject({ symbol: 'USDC', limit: '500000000' });
  });

  it('revokes what fails the check and reports what was left out', async () => {
    const { deps, revoked } = setup({ failChain: 8453, drop: [42161] });
    const result = await setUpAllowance({
      wallet: WALLET,
      appName: 'Claude',
      allowanceUsd: 100,
      days: 30,
      deps
    });
    expect(result.chains).toEqual(['Polygon']);
    expect(result.skipped.map((s) => s.chain)).toEqual(['Base', 'Arbitrum']);
    expect(revoked).toEqual([{ credentialId: 'cred-1', sessionId: 's-42161' }]);
  });

  it('approves nothing and revokes the key when no chain checks out', async () => {
    const { deps, asked, revoked } = setup({ drop: [137, 8453, 42161] });
    await expect(
      setUpAllowance({ wallet: WALLET, appName: 'Claude', allowanceUsd: 100, days: 30, deps })
    ).rejects.toThrow(MoneyError);
    expect(asked.at(-1)).toEqual({ op: 'revoke', wallet: WALLET });
    expect(revoked.at(-1)).toEqual({ credentialId: 'cred-1' });
  });

  it('refuses an allowance outside the limits before touching anything', async () => {
    const { deps, asked } = setup();
    await expect(
      setUpAllowance({ wallet: WALLET, appName: 'Claude', allowanceUsd: 5, days: 30, deps })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      setUpAllowance({ wallet: WALLET, appName: 'Claude', allowanceUsd: 100, days: 45, deps })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(asked).toEqual([]);
  });
});

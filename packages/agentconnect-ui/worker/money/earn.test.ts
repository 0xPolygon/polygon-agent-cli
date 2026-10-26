import { HYDRATE_PROXY_ADDRESS } from '0xtrails/hydrate';
import { decodeFunctionData, erc4626Abi } from 'viem';
import { describe, expect, it } from 'vitest';

import type { EarnDeps } from './earn.ts';

import { depositCall, listVaults, withdrawTxs } from './earn.ts';
import { WALLET } from './test-fakes.ts';

const VAULT = '0x00000000000000000000000000000000000000f1';
const USDC_KATANA = '0x203a662b0bd271a6ed5a60edfbd04bfce608fd36';

const market = (overrides: Record<string, unknown> = {}) => ({
  id: 'm1',
  metadata: { name: 'Prime USDC' },
  inputTokens: [{ symbol: 'vbUSDC', decimals: 6, address: USDC_KATANA }],
  outputToken: { address: VAULT },
  rewardRate: { total: 0.0612 },
  statistics: { tvlUsd: '2500000' },
  status: { enter: true },
  ...overrides
});

const deps = (items: unknown[], shares = 0n): EarnDeps => ({
  trailsKey: 'k',
  fetch: (async () => Response.json({ items })) as typeof fetch,
  read: async ({ fn, args }) => {
    if (fn === 'asset') return USDC_KATANA;
    if (fn === 'balanceOf') return shares;
    if (fn === 'convertToAssets') return (args[0] as bigint) * 2n;
    if (fn === 'convertToShares') return (args[0] as bigint) / 2n;
    throw new Error(fn);
  }
});

describe('earn', () => {
  it('lists open, sizeable stablecoin vaults', async () => {
    const vaults = await listVaults(
      'katana',
      deps([
        market(),
        market({ id: 'closed', status: { enter: false } }),
        market({ id: 'tiny', statistics: { tvlUsd: '500' } })
      ])
    );
    expect(vaults).toEqual([
      expect.objectContaining({
        chainId: 747474,
        name: 'Prime USDC',
        apy: 6.12,
        asset: expect.objectContaining({ symbol: 'USDC' })
      })
    ]);
  });

  it("deposits for the wallet through Trails' executor", async () => {
    const { vault, call } = await depositCall(
      { vault: VAULT, amount: '50', chain: 'katana', wallet: WALLET },
      deps([market()])
    );
    expect(vault.chainId).toBe(747474);
    expect(call.to).toBe(HYDRATE_PROXY_ADDRESS);
    // The vault's deposit, for the wallet, and leftovers swept to the wallet.
    const data = call.data.toLowerCase();
    expect(data).toContain(VAULT.slice(2).toLowerCase());
    expect(data).toContain(WALLET.slice(2).toLowerCase());
  });

  it('withdraws everything by redeeming all shares', async () => {
    const { txs, amount } = await withdrawTxs(
      { vault: VAULT, amount: 'all', chain: 'katana', wallet: WALLET },
      deps([market()], 10_000_000n)
    );
    expect(amount).toBe('20');
    expect(decodeFunctionData({ abi: erc4626Abi, data: txs.transactions[0].data })).toMatchObject({
      functionName: 'redeem',
      args: [10_000_000n, WALLET, WALLET]
    });
  });

  it("refuses a vault Trails doesn't list, and more than is deposited", async () => {
    await expect(
      depositCall(
        {
          vault: '0x00000000000000000000000000000000000000f2',
          amount: '1',
          chain: 'katana',
          wallet: WALLET
        },
        deps([market()])
      )
    ).rejects.toMatchObject({ code: 'not_covered' });
    await expect(
      withdrawTxs(
        { vault: VAULT, amount: '100', chain: 'katana', wallet: WALLET },
        deps([market()], 1_000_000n)
      )
    ).rejects.toMatchObject({ code: 'insufficient_balance' });
  });
});

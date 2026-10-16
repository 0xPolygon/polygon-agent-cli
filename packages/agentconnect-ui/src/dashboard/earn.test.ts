import { describe, expect, it } from 'vitest';

import { pickVaults } from './earn.js';

const market = (
  id: string,
  tvl: number,
  rate: number,
  over: { symbol?: string; enter?: boolean; deprecated?: boolean } = {}
) => ({
  id,
  inputTokens: [{ symbol: over.symbol ?? 'vbUSDC', decimals: 6 }],
  outputToken: { address: `0x${id.padStart(40, '0')}` },
  rewardRate: { total: rate },
  statistics: { tvlUsd: String(tvl) },
  status: { enter: over.enter ?? true },
  metadata: { deprecated: over.deprecated ?? false, underMaintenance: false }
});

describe('pickVaults', () => {
  it('assigns Prime, Frontier, and Advanced largest first', () => {
    const vaults = pickVaults([
      market('a', 12_500, 0.0961),
      market('b', 3_100_000, 0.021),
      market('c', 562_000, 0.0771)
    ]);
    expect(vaults.map((v) => [v.tier.name, v.marketId])).toEqual([
      ['Prime', 'b'],
      ['Frontier', 'c'],
      ['Advanced', 'a']
    ]);
    expect(vaults[0]).toMatchObject({ apy: 2.1, symbol: 'USDC', decimals: 6 });
  });

  it('skips small, closed, deprecated, zero-rate, and non-stablecoin vaults', () => {
    const vaults = pickVaults([
      market('small', 9_000, 0.05),
      market('closed', 1_000_000, 0.05, { enter: false }),
      market('old', 1_000_000, 0.05, { deprecated: true }),
      market('zero', 1_000_000, 0),
      market('dust', 1_000_000, 0.0000004),
      market('eth', 1_000_000, 0.05, { symbol: 'vbETH' }),
      market('ausd', 1_000_000, 0.05, { symbol: 'AUSD' }),
      market('ok', 50_000, 0.03, { symbol: 'vbUSDT' })
    ]);
    expect(vaults.map((v) => [v.tier.name, v.marketId])).toEqual([['Prime', 'ok']]);
  });

  it('keeps at most three', () => {
    const vaults = pickVaults(
      ['a', 'b', 'c', 'd'].map((id, i) => market(id, 100_000 * (4 - i), 0.02 + 0.01 * i))
    );
    expect(vaults.map((v) => v.marketId)).toEqual(['a', 'b', 'c']);
  });

  it('never offers a riskier tier that pays less than a safer one', () => {
    // Today's Katana: the smallest vault pays less than the middle one.
    const vaults = pickVaults([
      market('prime', 3_066_894, 0.0191),
      market('frontier', 574_891, 0.0794),
      market('small', 12_511, 0.0474),
      market('tiny-but-high', 11_000, 0.095)
    ]);
    expect(vaults.map((v) => [v.tier.name, v.marketId])).toEqual([
      ['Prime', 'prime'],
      ['Frontier', 'frontier'],
      ['Advanced', 'tiny-but-high']
    ]);
  });

  it('needs a clear step up in rate, not a rounding difference', () => {
    const vaults = pickVaults([market('a', 1_000_000, 0.03), market('b', 500_000, 0.032)]);
    expect(vaults.map((v) => v.marketId)).toEqual(['a']);
  });
});

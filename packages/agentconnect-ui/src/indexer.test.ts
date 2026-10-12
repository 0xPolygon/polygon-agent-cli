import { describe, expect, it } from 'vitest';

import type { ActivityItem } from './indexer';

import { classifyToken, dailyFlow } from './indexer';

describe('classifyToken', () => {
  it('treats Aave aTokens as earning', () => {
    expect(classifyToken('aPolUSDC', 'Aave Polygon USDC')).toEqual({
      kind: 'earn',
      protocol: 'Aave'
    });
  });

  it('treats vault shares as earning', () => {
    expect(classifyToken('mUSDC', 'Morpho USDC Vault').kind).toBe('earn');
  });

  it('treats plain tokens as spendable', () => {
    expect(classifyToken('USDC', 'USD Coin')).toEqual({ kind: 'spend' });
  });
});

describe('dailyFlow', () => {
  const now = new Date(2026, 9, 12, 15, 0);
  const item = (daysAgo: number, direction: 'in' | 'out', usd: number): ActivityItem => ({
    txnHash: '0x',
    timestamp: new Date(2026, 9, 12 - daysAgo, 10, 0).toISOString(),
    direction,
    symbol: 'USDC',
    qty: usd,
    usd,
    counterparty: '0x'
  });

  it('buckets by local day, oldest first, ending today', () => {
    const days = dailyFlow([item(0, 'in', 50), item(0, 'out', 5), item(13, 'out', 2)], 14, now);
    expect(days).toHaveLength(14);
    expect(days[13]).toMatchObject({ in: 50, out: 5 });
    expect(days[0]).toMatchObject({ in: 0, out: 2 });
  });

  it('drops items outside the window', () => {
    const days = dailyFlow([item(14, 'in', 99)], 14, now);
    expect(days.every((d) => d.in === 0 && d.out === 0)).toBe(true);
  });
});

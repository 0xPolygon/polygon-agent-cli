import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActivityItem } from './indexer';

import { classifyToken, dailyFlow, priceReceipts } from './indexer';

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

describe('priceReceipts', () => {
  const USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
  const USDT0 = '0xc2132d05d31c914a87c6611c10748aeb04b58e8f';
  const pad = (hex: string) => `0x${hex.replace(/^0x/, '').padStart(64, '0')}`;
  const VAULT = '0x00000000000000000000000000000000000000aa';
  const ATOKEN = '0x00000000000000000000000000000000000000bb';
  const OTHER = '0x00000000000000000000000000000000000000cc';

  afterEach(() => vi.unstubAllGlobals());

  it('values vault shares and aTokens backed by stablecoins', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const calls = JSON.parse(init.body) as {
          id: number;
          params: [{ to: string; data: string }];
        }[];
        const answer = ({ to, data }: { to: string; data: string }) => {
          if (to === VAULT && data === '0x38d52e0f') return pad(USDC);
          if (to === ATOKEN && data === '0xb16a19de') return pad(USDT0);
          if (to === VAULT && data.startsWith('0x07a2d13a')) return pad((1_500_000).toString(16));
          return undefined;
        };
        return new Response(
          JSON.stringify(calls.map((c) => ({ id: c.id, result: answer(c.params[0]) })))
        );
      })
    );
    const priced = await priceReceipts(137, [
      { address: VAULT, raw: 1_400_000_000_000_000_000n },
      { address: ATOKEN, raw: 151_463n },
      { address: OTHER, raw: 5n }
    ]);
    expect(priced.get(VAULT)).toBe(1.5);
    expect(priced.get(ATOKEN)).toBeCloseTo(0.151463);
    expect(priced.has(OTHER)).toBe(false);
  });

  it('only prices on Polygon', async () => {
    expect((await priceReceipts(1, [{ address: VAULT, raw: 1n }])).size).toBe(0);
  });
});

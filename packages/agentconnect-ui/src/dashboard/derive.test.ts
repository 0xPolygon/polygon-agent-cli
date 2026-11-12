import { describe, expect, it } from 'vitest';

import type { ActivityItem, Holding } from '../indexer';

import { activityType, filterHoldings } from './derive.js';

const holding = (symbol: string, name: string): Holding => ({
  address: `0x${symbol.toLowerCase()}`,
  symbol,
  name,
  qty: 1,
  usd: 1,
  kind: 'spend'
});

const transfer = (txnHash: string, direction: ActivityItem['direction']): ActivityItem => ({
  txnHash,
  timestamp: '2026-11-03T10:00:00Z',
  direction,
  symbol: 'USDC',
  qty: 5,
  usd: 5,
  counterparty: '0x0000000000000000000000000000000000000001'
});

describe('filterHoldings', () => {
  const holdings = [holding('USDC', 'USD Coin'), holding('POL', 'Polygon Ecosystem Token')];

  it('returns everything for an empty or blank query', () => {
    expect(filterHoldings({ holdings, query: '' })).toEqual(holdings);
    expect(filterHoldings({ holdings, query: '   ' })).toEqual(holdings);
  });

  it('matches the symbol regardless of case', () => {
    expect(filterHoldings({ holdings, query: 'usdc' })).toEqual([holdings[0]]);
  });

  it('matches the name regardless of case', () => {
    expect(filterHoldings({ holdings, query: 'ECOSYSTEM' })).toEqual([holdings[1]]);
  });

  it('matches the name the user sees when it differs from the indexer name', () => {
    const displayNames = { [holdings[0].address]: 'Dollar Token' };
    expect(filterHoldings({ holdings, query: 'dollar', displayNames })).toEqual([holdings[0]]);
    expect(filterHoldings({ holdings, query: 'usd coin', displayNames })).toEqual([holdings[0]]);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterHoldings({ holdings, query: 'zzz' })).toEqual([]);
  });
});

describe('activityType', () => {
  it('treats a lone incoming transfer as a receive', () => {
    const item = transfer('0xa', 'in');
    expect(activityType({ item, items: [item] })).toBe('receive');
  });

  it('treats a lone outgoing transfer as a send', () => {
    const item = transfer('0xa', 'out');
    expect(activityType({ item, items: [item] })).toBe('send');
  });

  it('treats an in and an out in one transaction as a swap', () => {
    const received = transfer('0xa', 'in');
    const sent = transfer('0xa', 'out');
    const items = [received, sent];
    expect(activityType({ item: received, items })).toBe('swap');
    expect(activityType({ item: sent, items })).toBe('swap');
  });

  it('keeps two outgoing transfers in one transaction as sends', () => {
    const first = transfer('0xa', 'out');
    const second = transfer('0xa', 'out');
    expect(activityType({ item: first, items: [first, second] })).toBe('send');
  });

  it('ignores opposite transfers from other transactions', () => {
    const sent = transfer('0xa', 'out');
    const other = transfer('0xb', 'in');
    expect(activityType({ item: sent, items: [sent, other] })).toBe('send');
  });
});

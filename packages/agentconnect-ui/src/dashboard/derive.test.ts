import { describe, expect, it } from 'vitest';

import type { ActivityItem, Holding } from '../indexer';

import { activityType, filterHoldings, logoAddresses, logosByAddress } from './derive.js';

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
  counterparty: '0x0000000000000000000000000000000000000001',
  address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'
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

describe('activity logos by address', () => {
  const REAL_USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
  const SPOOF_USDC = '0x00000000000000000000000000000000000000ee';
  const items = [
    { ...transfer('0x1', 'in'), address: REAL_USDC },
    { ...transfer('0x2', 'in'), address: SPOOF_USDC },
    { ...transfer('0x3', 'out'), address: REAL_USDC },
    { ...transfer('0x4', 'out'), address: '' }
  ];

  it('gives a spoof with a well-known symbol no logo, and the real address its own', () => {
    const logos = logosByAddress({
      [REAL_USDC]: { name: 'USD Coin', logo: 'https://img.test/usdc.png' },
      [SPOOF_USDC]: { name: 'Fake' }
    });
    expect(logos[REAL_USDC]).toBe('https://img.test/usdc.png');
    expect(logos[SPOOF_USDC]).toBeUndefined();
  });

  it('looks up each distinct address once, skips empty ones and honours the cap', () => {
    expect(logoAddresses({ items, limit: 10 })).toEqual([REAL_USDC, SPOOF_USDC]);
    expect(logoAddresses({ items, limit: 1 })).toEqual([REAL_USDC]);
  });
});

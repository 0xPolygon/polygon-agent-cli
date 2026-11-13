import { describe, expect, it } from 'vitest';

import type { ActivityItem } from '../indexer';

import { activityType } from '../dashboard/derive.js';
import { visibleActivity } from './visibleActivity.js';

const row = (overrides: Partial<ActivityItem> = {}): ActivityItem => ({
  txnHash: '0xaaaa',
  timestamp: '2026-11-03T10:00:00Z',
  direction: 'in',
  symbol: 'TKN',
  qty: 1,
  usd: 0,
  counterparty: '0x1111111111111111111111111111111111111111',
  address: '0x2222222222222222222222222222222222222222',
  scaleKnown: false,
  ...overrides
});

describe('visibleActivity', () => {
  it('hides a collectible-style row with no known scale and no value', () => {
    expect(visibleActivity([row({ symbol: '' })])).toEqual([]);
  });

  it('hides a spam token with no known scale and no value', () => {
    expect(visibleActivity([row({ symbol: 'Visit example.test to claim' })])).toEqual([]);
  });

  it('keeps an outbound row with no known scale and no value, while its inbound twin stays hidden', () => {
    const sent = row({ direction: 'out' });
    expect(visibleActivity([sent, row({ direction: 'in' })])).toEqual([sent]);
  });

  it('keeps a row whose decimals are known even when it has no USD value', () => {
    const dust = row({ scaleKnown: true });
    expect(visibleActivity([dust])).toEqual([dust]);
  });

  it('keeps a row with no known scale but a USD value', () => {
    const priced = row({ usd: 3 });
    expect(visibleActivity([priced])).toEqual([priced]);
  });

  it('keeps a native transfer', () => {
    const native = row({ symbol: 'POL', address: '', scaleKnown: true });
    expect(visibleActivity([native])).toEqual([native]);
  });

  it('still labels the stablecoin row a swap when its other leg is hidden', () => {
    const stable = row({ direction: 'out', symbol: 'USDC', usd: 5, scaleKnown: true });
    const shares = row({ direction: 'in' });
    const items = [stable, shares];
    expect(visibleActivity(items)).toEqual([stable]);
    expect(activityType({ item: stable, items })).toBe('swap');
  });
});

import { describe, expect, it } from 'vitest';

import type { Position } from '../dashboard/markets.js';

import { groupPositions, marketGain, predictionsTotal } from './groupPositions.js';

const position = (overrides: Partial<Position>): Position => ({
  title: 'Market',
  outcome: 'Yes',
  avgPrice: 0.5,
  curPrice: 0.5,
  value: 0,
  cost: 0,
  pnl: 0,
  endDate: null,
  slug: 'market',
  ...overrides
});

describe('groupPositions', () => {
  it('sums cost and value across the outcomes held in one market', () => {
    const [market, ...rest] = groupPositions([
      position({ outcome: 'Yes', cost: 100, value: 150 }),
      position({ outcome: 'No', cost: 20, value: 5 })
    ]);
    expect(rest).toHaveLength(0);
    expect(market?.cost).toBe(120);
    expect(market?.value).toBe(155);
    expect(market?.positions).toHaveLength(2);
  });

  it('computes gain as value minus cost, ignoring the reported profit', () => {
    const [gainer, loser] = groupPositions([
      position({ title: 'A', slug: 'a', cost: 74016.67, value: 115019.85, pnl: 42606.33 }),
      position({ title: 'B', slug: 'b', cost: 50, value: 20, pnl: -25 })
    ]);
    expect(gainer?.gain).toBeCloseTo(41003.18, 2);
    expect(loser?.gain).toBeCloseTo(-30, 2);
  });

  it('adds up to total value minus total cost', () => {
    const input = [
      position({ title: 'A', slug: 'a', cost: 10.1, value: 12.3 }),
      position({ title: 'A', slug: 'a', outcome: 'No', cost: 3.3, value: 1.1 }),
      position({ title: 'B', slug: 'b', cost: 40, value: 25.55 })
    ];
    const gains = groupPositions(input).reduce((sum, m) => sum + m.gain, 0);
    const value = input.reduce((sum, p) => sum + p.value, 0);
    const cost = input.reduce((sum, p) => sum + p.cost, 0);
    expect(gains).toBeCloseTo(value - cost, 9);
  });

  it('takes the gain from the rounded cost and value so each card adds up on screen', () => {
    const [market] = groupPositions([
      position({ outcome: 'Yes', cost: 60.002, value: 120.003 }),
      position({ outcome: 'No', cost: 40.002, value: 80.003 })
    ]);
    expect(market?.cost).toBe(100);
    expect(market?.value).toBe(200.01);
    expect(market?.gain).toBe(100.01);
  });

  it('prints worth minus contribution as the market gain', () => {
    expect(marketGain({ cost: 120, value: 155, unrealizedPnl: 99 })).toBe(35);
    expect(marketGain({ cost: 50, value: 20, unrealizedPnl: 99 })).toBe(-30);
    const [market] = groupPositions([
      position({ outcome: 'Yes', cost: 100, value: 150, pnl: 49 }),
      position({ outcome: 'No', cost: 20, value: 5, pnl: -14 })
    ]);
    expect(market?.gain).toBe(35);
  });

  it('carries the reported unrealised profit, summed per market', () => {
    const groups = groupPositions([
      position({ title: 'A', slug: 'a', outcome: 'Yes', pnl: 42.5 }),
      position({ title: 'A', slug: 'a', outcome: 'No', pnl: -2.25 }),
      position({ title: 'B', slug: 'b', pnl: 7 })
    ]);
    expect(groups.map((g) => g.unrealizedPnl)).toEqual([40.25, 7]);
  });
});

describe('predictionsTotal', () => {
  it('adds the rounded worth to the rounded cash, as the header lines do', () => {
    const positions = [position({ value: 44956.104 })];
    const total = predictionsTotal({ positions, cash: 1246.9249 });
    expect(total).toBe(46203.02);
    expect(Math.round((44956.104 + 1246.9249) * 100) / 100).toBe(46203.03);
  });

  it('counts missing cash as zero', () => {
    expect(predictionsTotal({ positions: [position({ value: 10.005 })], cash: null })).toBe(10.01);
  });
});

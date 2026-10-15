import { describe, expect, it } from 'vitest';

import type { WatchState } from './evaluate.ts';

import { alreadyPast, evaluate } from './evaluate.ts';

const base: WatchState = {
  buyBelow: 2000,
  sellAbove: 3000,
  buyArmed: true,
  sellArmed: true,
  staleNotified: false
};

const at = (state: WatchState, price: number | undefined, stale = false) =>
  evaluate({ state, price, priceAt: '2026-10-07T12:00:00Z', stale });

describe('evaluate', () => {
  it('fires a buy at or below the level once, then waits for a 2% move back', () => {
    const first = at(base, 2000);
    expect(first.events).toEqual(['buy_below']);
    expect(first.next.buyArmed).toBe(false);

    // Still below, and back up but under 2%: nothing.
    expect(at(first.next, 1990).events).toEqual([]);
    const notYet = at(first.next, 2039);
    expect(notYet.next.buyArmed).toBe(false);

    const rearmed = at(first.next, 2040).next;
    expect(rearmed.buyArmed).toBe(true);
    expect(at(rearmed, 1999).events).toEqual(['buy_below']);
  });

  it('mirrors it for a sell: at or above, re-armed 2% below', () => {
    const first = at(base, 3100);
    expect(first.events).toEqual(['sell_above']);
    expect(at(first.next, 2941).next.sellArmed).toBe(false);
    expect(at(first.next, 2940).next.sellArmed).toBe(true);
  });

  it('fires nothing between the levels and records the price', () => {
    const result = at(base, 2500);
    expect(result.events).toEqual([]);
    expect(result.next).toMatchObject({ lastPrice: 2500, buyArmed: true, sellArmed: true });
  });

  it('a stale or missing price fires nothing, alerting once per stale stretch', () => {
    const stale = at(base, 1000, true);
    expect(stale.events).toEqual([]);
    expect(stale.staleAlert).toBe(true);
    expect(at(stale.next, undefined).staleAlert).toBe(false);
    // A fresh price ends the stretch.
    const fresh = at(stale.next, 2500);
    expect(fresh.next.staleNotified).toBe(false);
    expect(at(fresh.next, undefined).staleAlert).toBe(true);
  });

  it('only watches the levels that are set', () => {
    expect(at({ ...base, sellAbove: undefined }, 5000).events).toEqual([]);
  });
});

describe('alreadyPast', () => {
  it('names the levels the current price has crossed', () => {
    expect(alreadyPast({ buyBelow: 2000, sellAbove: 3000, price: 2500 })).toEqual([]);
    expect(alreadyPast({ buyBelow: 2000, price: 2000 })).toEqual(['buy_below']);
    expect(alreadyPast({ sellAbove: 3000, price: 3500 })).toEqual(['sell_above']);
  });
});

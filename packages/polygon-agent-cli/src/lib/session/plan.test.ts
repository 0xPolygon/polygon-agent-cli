import { describe, expect, it } from 'vitest';

import type { PlanToken } from './plan.ts';

import { CliError } from '../errors.ts';
import { priceKey } from '../prices.ts';
import { buildPlan, limitFor, parsePlan, planSummary, planToJson, toGrants } from './plan.ts';
import { supportedTokens } from './tokens.ts';

const NOW = new Date('2026-10-06T00:00:00Z');

const polygon: PlanToken[] = supportedTokens(137).map((t) => ({ chainId: 137, ...t }));
const base: PlanToken[] = supportedTokens(8453).map((t) => ({ chainId: 8453, ...t }));

function prices(entries: Array<[PlanToken, number]>): Map<string, number> {
  return new Map(
    entries.map(([token, price]) => [
      priceKey({ chainId: token.chainId, address: token.address }),
      price
    ])
  );
}

const byPrice = (tokens: PlanToken[]) =>
  prices(
    tokens
      .filter((t) => t.kind !== 'usd')
      .map((t) => [t, t.kind === 'eth' ? 2500 : t.kind === 'btc' ? 80_000 : 0.25])
  );

describe('limitFor', () => {
  it('rounds down to token units', () => {
    expect(limitFor({ allowanceUsd: 1000, priceUsd: 1, decimals: 6 })).toBe(1_000_000_000n);
    expect(limitFor({ allowanceUsd: 1000, priceUsd: 2500, decimals: 18 })).toBe(
      400_000_000_000_000_000n
    );
    // 1000 / 3 = 333.333… → floor at 6 decimals.
    expect(limitFor({ allowanceUsd: 1000, priceUsd: 3, decimals: 6 })).toBe(333_333_333n);
    expect(limitFor({ allowanceUsd: 10, priceUsd: 80_000, decimals: 8 })).toBe(12_500n);
  });

  it('handles 18-decimal tokens without float error', () => {
    // $1,000 of WPOL at $0.107559: 9297.223… WPOL.
    const limit = limitFor({ allowanceUsd: 1000, priceUsd: 0.107559, decimals: 18 });
    expect(limit).toBe((100000n * 10n ** 18n * 10n ** 12n) / (107_559_000_000n * 100n));
  });
});

describe('buildPlan', () => {
  it('gives every covered token on every chain a limit worth the whole allowance', () => {
    const tokens = [...polygon, ...base];
    const plan = buildPlan({
      allowanceUsd: 1000,
      days: 30,
      tokens,
      prices: byPrice(tokens),
      now: NOW
    });
    expect(plan.expiresAt).toBe('2026-11-05T00:00:00.000Z');
    expect(plan.chains.map((c) => c.chainId)).toEqual([137, 8453]);
    const usdc = plan.chains[0].grants.find((g) => g.symbol === 'USDC');
    const weth = plan.chains[0].grants.find((g) => g.symbol === 'WETH');
    expect(usdc).toMatchObject({ limit: 1_000_000_000n, priceUsd: 1 });
    expect(weth).toMatchObject({ limit: 400_000_000_000_000_000n, priceUsd: 2500 });
  });

  it('prices stablecoins at $1 without asking, and fails rather than guessing other prices', () => {
    const usdOnly = polygon.filter((t) => t.kind === 'usd');
    expect(() =>
      buildPlan({ allowanceUsd: 100, days: 7, tokens: usdOnly, prices: new Map(), now: NOW })
    ).not.toThrow();
    const error = (() => {
      try {
        buildPlan({ allowanceUsd: 100, days: 7, tokens: polygon, prices: new Map(), now: NOW });
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: 'upstream_unavailable' });
  });

  it.each([
    [5, 30],
    [100_001, 30],
    [1000, 0],
    [1000, 31],
    [1000, 1.5]
  ])('rejects allowance %d over %d days', (allowanceUsd, days) => {
    expect(() =>
      buildPlan({ allowanceUsd, days, tokens: polygon, prices: byPrice(polygon), now: NOW })
    ).toThrow(CliError);
  });

  it.each([
    ['WETH', 0.000001],
    ['WETH', 5_000_000],
    ['WBTC', 1],
    ['WPOL', 0]
  ])('refuses a %s price of $%d rather than set a runaway limit from it', (symbol, price) => {
    const token = polygon.find((t) => t.symbol === symbol);
    if (!token) throw new Error(`no ${symbol}`);
    const all = byPrice(polygon);
    all.set(priceKey({ chainId: token.chainId, address: token.address }), price);
    expect(() =>
      buildPlan({ allowanceUsd: 1000, days: 30, tokens: polygon, prices: all, now: NOW })
    ).toThrow(/looks wrong/);
  });

  it('refuses more than 127 tokens on a chain', () => {
    const many: PlanToken[] = Array.from({ length: 128 }, (_, i) => ({
      chainId: 137,
      symbol: `T${i}`,
      address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
      decimals: 6,
      kind: 'usd' as const
    }));
    expect(() =>
      buildPlan({ allowanceUsd: 100, days: 7, tokens: many, prices: new Map(), now: NOW })
    ).toThrow(expect.objectContaining({ code: 'too_many_tokens' }));
  });

  it('on an allowance change, keeps session ids and expiry and reprices every token', () => {
    const current = {
      ...buildPlan({
        allowanceUsd: 1000,
        days: 30,
        tokens: polygon,
        prices: byPrice(polygon),
        now: NOW
      }),
      chains: []
    };
    const first = buildPlan({
      allowanceUsd: 1000,
      days: 30,
      tokens: polygon,
      prices: byPrice(polygon),
      now: NOW
    });
    first.chains[0].sessionId = 'sess-1';
    const later = new Date('2026-10-10T00:00:00Z');
    const raised = buildPlan({
      allowanceUsd: 2000,
      days: 30,
      tokens: [],
      prices: byPrice(polygon),
      now: later,
      current: first
    });
    expect(raised.expiresAt).toBe(first.expiresAt);
    expect(raised.chains[0].sessionId).toBe('sess-1');
    expect(raised.chains[0].grants.find((g) => g.symbol === 'USDC')?.limit).toBe(2_000_000_000n);
    expect(current.chains).toEqual([]);
  });

  it('adding a token leaves existing limits alone and adds a new chain without a session id', () => {
    const first = buildPlan({
      allowanceUsd: 1000,
      days: 30,
      tokens: polygon,
      prices: byPrice(polygon),
      now: NOW
    });
    first.chains[0].sessionId = 'sess-1';
    const before = first.chains[0].grants.map((g) => g.limit);
    const added = buildPlan({
      allowanceUsd: 1000,
      days: 30,
      tokens: base,
      prices: byPrice([...polygon, ...base]),
      now: NOW,
      current: first
    });
    expect(added.chains[0].grants.map((g) => g.limit)).toEqual(before);
    expect(added.chains[1]).toMatchObject({ chainId: 8453 });
    expect(added.chains[1].sessionId).toBeUndefined();
  });
});

describe('plan helpers', () => {
  const plan = buildPlan({
    allowanceUsd: 1000,
    days: 30,
    tokens: polygon,
    prices: byPrice(polygon),
    now: NOW
  });

  it('makes cumulative any-recipient ERC-20 grants', () => {
    expect(toGrants(plan.chains[0])[0]).toEqual({
      kind: 'erc20Transfer',
      token: polygon[0].address,
      limit: 1_000_000_000n,
      cumulative: true
    });
  });

  it('round-trips through JSON', () => {
    expect(parsePlan(JSON.parse(JSON.stringify(planToJson(plan))))).toEqual(plan);
  });

  it('summarises in plain language with formatted limits', () => {
    const summary = planSummary(plan);
    expect(summary.summary).toContain('Spend up to $1,000 in total until 2026-11-05');
    expect(summary.summary).toContain(
      "can't move more than $1,000 worth of any one token on any one chain"
    );
    expect(JSON.stringify(summary.chains)).toContain('"limit":"1000"');
  });
});

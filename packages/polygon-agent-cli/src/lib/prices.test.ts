import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ getTokenPrices: vi.fn() }));

vi.mock('@0xtrails/api', () => ({
  TrailsApi: class {
    getTokenPrices = fake.getTokenPrices;
  }
}));

process.env.TRAILS_API_KEY = 'test';
const { getPriceReadings, priceKey } = await import('./prices.ts');

const NOW = new Date('2026-10-07T12:00:00Z');
let n = 0;
// A fresh token per test: the cache lives for the process.
const token = () => ({ chainId: 137, address: `0x${String(++n).padStart(40, '0')}` });

function trailsSays(
  entries: Array<{ address: string; priceUsd: number | null; updatedAt: string }>
) {
  fake.getTokenPrices.mockResolvedValue({
    tokenPrices: entries.map((e) => ({
      token: { chainId: 137, tokenAddress: e.address },
      priceUsd: e.priceUsd,
      updatedAt: e.updatedAt
    }))
  });
}

beforeEach(() => fake.getTokenPrices.mockReset());

describe('getPriceReadings', () => {
  it('a recent price is fresh', async () => {
    const t = token();
    trailsSays([{ address: t.address, priceUsd: 2500, updatedAt: '2026-10-07T11:58:00Z' }]);
    const reading = (await getPriceReadings({ tokens: [t], now: NOW })).get(priceKey(t));
    expect(reading).toEqual({ usd: 2500, updatedAt: '2026-10-07T11:58:00.000Z', stale: false });
  });

  it('a price older than 5 minutes is stale', async () => {
    const t = token();
    trailsSays([{ address: t.address, priceUsd: 2500, updatedAt: '2026-10-07T11:54:59Z' }]);
    expect((await getPriceReadings({ tokens: [t], now: NOW })).get(priceKey(t))?.stale).toBe(true);
  });

  it('a price dated in the future (beyond a minute of skew) is stale', async () => {
    const t = token();
    trailsSays([{ address: t.address, priceUsd: 2500, updatedAt: '2026-10-07T12:05:00Z' }]);
    expect((await getPriceReadings({ tokens: [t], now: NOW })).get(priceKey(t))?.stale).toBe(true);
    const u = token();
    trailsSays([{ address: u.address, priceUsd: 2500, updatedAt: '2026-10-07T12:00:30Z' }]);
    expect((await getPriceReadings({ tokens: [u], now: NOW })).get(priceKey(u))?.stale).toBe(false);
  });

  it("a token Trails can't price is stale, with no price or time", async () => {
    const t = token();
    trailsSays([{ address: t.address, priceUsd: null, updatedAt: '0001-01-01T00:00:00Z' }]);
    expect((await getPriceReadings({ tokens: [t], now: NOW })).get(priceKey(t))).toEqual({
      stale: true
    });
  });

  it('a token missing from the answer is stale', async () => {
    const t = token();
    trailsSays([]);
    expect((await getPriceReadings({ tokens: [t], now: NOW })).get(priceKey(t))).toEqual({
      stale: true
    });
  });

  it('asks once per token, and reuses the reading for 30 s, judging staleness when read', async () => {
    const t = token();
    trailsSays([{ address: t.address, priceUsd: 2500, updatedAt: '2026-10-07T11:55:10Z' }]);
    await getPriceReadings({ tokens: [t, { ...t, address: t.address.toUpperCase() }], now: NOW });
    expect(fake.getTokenPrices).toHaveBeenCalledTimes(1);
    expect(fake.getTokenPrices.mock.calls[0][0].tokens).toHaveLength(1);

    const later = new Date(NOW.getTime() + 20_000);
    const reading = (await getPriceReadings({ tokens: [t], now: later })).get(priceKey(t));
    expect(fake.getTokenPrices).toHaveBeenCalledTimes(1);
    // Fresh at fetch time, past 5 minutes now.
    expect(reading?.stale).toBe(true);

    await getPriceReadings({ tokens: [t], now: new Date(NOW.getTime() + 31_000) });
    expect(fake.getTokenPrices).toHaveBeenCalledTimes(2);
  });
});

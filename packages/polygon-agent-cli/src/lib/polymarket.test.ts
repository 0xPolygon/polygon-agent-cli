// Polymarket read APIs: Data API v2 (positions) and Gamma (markets).
// Fixtures follow live responses captured on 2026-10-08.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertTradable,
  getMarket,
  getMarkets,
  getPositions,
  parseMarket,
  DATA_URL,
  GAMMA_URL
} from './polymarket.ts';

const V1_MARKET = {
  id: '5009042',
  conditionId: '0xe8b24aac1400d5d57d3657de489f705b0737c108aea5fe9b5a6e102c1c2fe5d8',
  question: 'Will Brighton & Hove Albion FC win on 2026-10-10?',
  version: 'v1',
  clobTokenIds: '["1066", "8181"]',
  positionIds: ['9136', '9137'],
  outcomes: '["Yes", "No"]',
  outcomePrices: '["0.415", "0.585"]',
  negRisk: true,
  active: true,
  closed: false,
  acceptingOrders: true,
  endDate: '2026-10-10T14:00:00Z',
  volume24hr: 1927.9
};

const V2_MARKET = { ...V1_MARKET, conditionId: '0xv2', version: 'v2' };

function mockFetch(...bodies: unknown[]) {
  const fn = vi.fn();
  for (const body of bodies) {
    fn.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
  }
  vi.stubGlobal('fetch', fn);
  return fn;
}

function calledUrl(fn: ReturnType<typeof vi.fn>, i = 0): URL {
  return new URL(String(fn.mock.calls[i][0]));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseMarket', () => {
  it('takes token ids from clobTokenIds for v1 markets', () => {
    const m = parseMarket(V1_MARKET);
    expect(m.version).toBe('v1');
    expect(m.yesTokenId).toBe('1066');
    expect(m.noTokenId).toBe('8181');
    expect(m.yesPrice).toBe(0.415);
    expect(m.acceptingOrders).toBe(true);
  });

  it('takes token ids from positionIds for v2 markets, even when clobTokenIds is present', () => {
    const m = parseMarket(V2_MARKET);
    expect(m.version).toBe('v2');
    expect(m.yesTokenId).toBe('9136');
    expect(m.noTokenId).toBe('9137');
  });

  it('leaves token ids empty for an unknown version', () => {
    const m = parseMarket({ ...V1_MARKET, version: 'v9' });
    expect(m.yesTokenId).toBeNull();
    expect(m.noTokenId).toBeNull();
  });

  it('treats a market without a version as v1', () => {
    const { version: _omit, ...legacy } = V1_MARKET;
    expect(parseMarket(legacy).yesTokenId).toBe('1066');
  });
});

describe('assertTradable', () => {
  it('accepts a v1 market that is taking orders', () => {
    expect(() => assertTradable(parseMarket(V1_MARKET))).not.toThrow();
  });

  it('refuses a v2 market with a clear code', () => {
    expect(() => assertTradable(parseMarket(V2_MARKET))).toThrow(
      expect.objectContaining({ code: 'unsupported_market_version' })
    );
  });

  it('refuses a market that is not accepting orders', () => {
    expect(() => assertTradable(parseMarket({ ...V1_MARKET, acceptingOrders: false }))).toThrow(
      expect.objectContaining({ code: 'market_not_accepting_orders' })
    );
  });
});

describe('getMarket', () => {
  it('looks a market up by condition id', async () => {
    const fetch = mockFetch([V1_MARKET]);
    const m = await getMarket(V1_MARKET.conditionId);
    expect(m.conditionId).toBe(V1_MARKET.conditionId);
    const url = calledUrl(fetch);
    expect(url.origin + url.pathname).toBe(`${GAMMA_URL}/markets`);
    expect(url.searchParams.get('condition_ids')).toBe(V1_MARKET.conditionId);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to closed markets, since Gamma hides them by default', async () => {
    const fetch = mockFetch([], [{ ...V1_MARKET, closed: true }]);
    const m = await getMarket(V1_MARKET.conditionId);
    expect(m.closed).toBe(true);
    expect(calledUrl(fetch, 1).searchParams.get('closed')).toBe('true');
  });

  it('throws when neither lookup finds the market', async () => {
    mockFetch([], []);
    await expect(getMarket('0xmissing')).rejects.toThrow(/Market not found/);
  });
});

describe('getMarkets', () => {
  it('lists by 24h volume through the keyset endpoint and returns the next cursor', async () => {
    const fetch = mockFetch({ markets: [V1_MARKET], next_cursor: 'abc' });
    const page = await getMarkets({ limit: 5 });
    const url = calledUrl(fetch);
    expect(url.pathname).toBe('/markets/keyset');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('closed')).toBe('false');
    expect(url.searchParams.get('order')).toBe('volume24hr');
    expect(page.markets).toHaveLength(1);
    expect(page.nextCursor).toBe('abc');
  });

  it('passes a cursor through as after_cursor', async () => {
    const fetch = mockFetch({ markets: [], next_cursor: null });
    const page = await getMarkets({ cursor: 'abc' });
    expect(calledUrl(fetch).searchParams.get('after_cursor')).toBe('abc');
    expect(page.nextCursor).toBeNull();
  });

  it('searches through public-search and keeps only open markets', async () => {
    const fetch = mockFetch({
      events: [
        { markets: [V1_MARKET, { ...V1_MARKET, conditionId: '0xclosed', closed: true }] },
        { markets: [{ ...V1_MARKET, conditionId: '0xother' }] }
      ],
      pagination: { hasMore: false }
    });
    const page = await getMarkets({ search: 'brighton', limit: 10 });
    const url = calledUrl(fetch);
    expect(url.pathname).toBe('/public-search');
    expect(url.searchParams.get('q')).toBe('brighton');
    expect(page.markets.map((m) => m.conditionId)).toEqual([V1_MARKET.conditionId, '0xother']);
    expect(page.nextCursor).toBeNull();
  });

  it('caps search results at the limit', async () => {
    mockFetch({ events: [{ markets: [V1_MARKET, { ...V1_MARKET, conditionId: '0x2' }] }] });
    const page = await getMarkets({ search: 'x', limit: 1 });
    expect(page.markets).toHaveLength(1);
  });
});

describe('getPositions', () => {
  it('reads Data API v2 positions and unwraps the envelope', async () => {
    const row = { proxy_wallet: '0xabc', token_id: '1', condition_id: '0xc', current_size: 5 };
    const fetch = mockFetch({
      data: [row],
      pagination: { limit: 20, offset: 0, has_more: true, next_cursor: 'n1' }
    });
    const page = await getPositions('0xabc');
    const url = calledUrl(fetch);
    expect(url.origin + url.pathname).toBe(`${DATA_URL}/v2/positions`);
    expect(url.searchParams.get('user')).toBe('0xabc');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.has('status')).toBe(false);
    expect(page.positions).toEqual([row]);
    expect(page.nextCursor).toBe('n1');
  });

  it('passes status and cursor through', async () => {
    const fetch = mockFetch({ data: [], pagination: { has_more: false, next_cursor: null } });
    const page = await getPositions('0xabc', { status: 'REDEEMABLE', cursor: 'c1', limit: 5 });
    const url = calledUrl(fetch);
    expect(url.searchParams.get('status')).toBe('REDEEMABLE');
    expect(url.searchParams.get('cursor')).toBe('c1');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(page.nextCursor).toBeNull();
  });

  it('surfaces API errors with the status code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('slow down', { status: 429 })));
    await expect(getPositions('0xabc')).rejects.toThrow(/429/);
  });
});

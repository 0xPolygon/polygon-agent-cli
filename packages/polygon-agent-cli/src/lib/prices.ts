// USD prices from Trails (GetTokenPrices). One call for any number of tokens.

import { loadBuilderConfig } from './storage.ts';

export interface PriceQuery {
  chainId: number;
  address: string;
}

export function priceKey(token: PriceQuery): string {
  return `${token.chainId}:${token.address.toLowerCase()}`;
}

export async function trailsClient() {
  const { TrailsApi } = await import('@0xtrails/api');
  const apiKey =
    process.env.TRAILS_API_KEY ||
    process.env.SEQUENCE_PROJECT_ACCESS_KEY ||
    (await loadBuilderConfig())?.accessKey ||
    '';
  return new TrailsApi(apiKey, { hostname: process.env.TRAILS_API_HOSTNAME });
}

// Prices by priceKey. Tokens Trails can't price are absent; callers decide
// what that means (plans fail rather than guess).
export async function getUsdPrices(tokens: PriceQuery[]): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  if (tokens.length === 0) return prices;
  const trails = await trailsClient();
  const res = await trails.getTokenPrices({
    tokens: tokens.map((token) => ({ chainId: token.chainId, tokenAddress: token.address }))
  });
  for (const entry of res.tokenPrices ?? []) {
    if (typeof entry.priceUsd === 'number' && entry.priceUsd > 0) {
      prices.set(
        priceKey({ chainId: entry.token.chainId, address: entry.token.tokenAddress }),
        entry.priceUsd
      );
    }
  }
  return prices;
}

// --- prices for people and watches (FS §8.1) ------------------------------

const NATIVE = '0x0000000000000000000000000000000000000000';
// A price older than this, or none at all, is stale: shown as such, and it
// never triggers a watch.
export const STALE_PRICE_MS = 5 * 60 * 1000;
const CACHE_MS = 30 * 1000;

// Where a symbol named without --chain is priced.
const CANONICAL: Readonly<Record<string, PriceQuery>> = {
  ETH: { chainId: 1, address: NATIVE },
  WETH: { chainId: 1, address: NATIVE },
  BTC: { chainId: 1, address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' },
  WBTC: { chainId: 1, address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' },
  CBBTC: { chainId: 1, address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' },
  POL: { chainId: 137, address: NATIVE },
  WPOL: { chainId: 137, address: NATIVE },
  USDC: { chainId: 1, address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  USDT: { chainId: 1, address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
  USDG: { chainId: 1, address: '0xe343167631d89B6Ffc58B88d6b7fB0228795491D' }
};

export function canonicalPriceToken(symbol: string): PriceQuery | undefined {
  return CANONICAL[symbol.trim().toUpperCase()];
}

export interface PriceReading {
  // Absent when Trails has no price.
  usd?: number;
  updatedAt?: string;
  stale: boolean;
}

const cache = new Map<string, { usd?: number; updatedAtMs: number; fetchedAt: number }>();

const CLOCK_SKEW_MS = 60_000;

// A price is fresh for 5 minutes after its timestamp. One dated in the future
// (beyond a minute of clock skew) can't be judged, so it counts as stale.
export function priceIsFresh(params: { updatedAtMs: number; now: number }): boolean {
  const age = params.now - params.updatedAtMs;
  return Number.isFinite(age) && age >= -CLOCK_SKEW_MS && age <= STALE_PRICE_MS;
}

// Staleness is judged when read, not when fetched.
function toReading(params: { usd?: number; updatedAtMs: number; now: number }): PriceReading {
  const { usd, updatedAtMs: at, now } = params;
  return {
    ...(usd !== undefined ? { usd } : {}),
    ...(Number.isFinite(at) && at > 0 ? { updatedAt: new Date(at).toISOString() } : {}),
    stale: !(usd !== undefined && priceIsFresh({ updatedAtMs: at, now }))
  };
}

// One Trails call for every token not read in the last 30 s. A token Trails
// can't price comes back stale with no usd.
export async function getPriceReadings(params: {
  tokens: PriceQuery[];
  now: Date;
}): Promise<Map<string, PriceReading>> {
  const now = params.now.getTime();
  const readings = new Map<string, PriceReading>();
  const missing: PriceQuery[] = [];
  for (const token of params.tokens) {
    const key = priceKey(token);
    const hit = cache.get(key);
    if (hit && now - hit.fetchedAt < CACHE_MS) readings.set(key, toReading({ ...hit, now }));
    else if (!missing.some((m) => priceKey(m) === key)) missing.push(token);
  }
  if (missing.length > 0) {
    const trails = await trailsClient();
    const res = await trails.getTokenPrices({
      tokens: missing.map((token) => ({ chainId: token.chainId, tokenAddress: token.address }))
    });
    const byKey = new Map(
      (res.tokenPrices ?? []).map((entry) => [
        priceKey({ chainId: entry.token.chainId, address: entry.token.tokenAddress }),
        entry
      ])
    );
    for (const token of missing) {
      const key = priceKey(token);
      const entry = byKey.get(key);
      const usd =
        typeof entry?.priceUsd === 'number' && entry.priceUsd > 0 ? entry.priceUsd : undefined;
      const updatedAtMs = entry?.updatedAt ? Date.parse(entry.updatedAt) : NaN;
      cache.set(key, { ...(usd !== undefined ? { usd } : {}), updatedAtMs, fetchedAt: now });
      readings.set(key, toReading({ usd, updatedAtMs, now }));
    }
  }
  return readings;
}

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

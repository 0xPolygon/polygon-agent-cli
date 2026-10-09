// Checks the supported table against Trails' live chain and token lists. A
// network test: runs only with RUN_NETWORK_TESTS=1 (e.g. in a scheduled CI job).

import { describe, expect, it } from 'vitest';

import { getUsdPrices, priceKey, trailsClient } from '../prices.ts';
import { SUPPORTED, chainLabel } from './tokens.ts';

const run = process.env.RUN_NETWORK_TESTS === '1';

describe.skipIf(!run)('supported table vs Trails (network)', () => {
  it('every chain is a Trails chain', async () => {
    const trails = await trailsClient();
    const { chains } = await trails.getChains({});
    const ids = new Set(chains.map((chain) => chain.id));
    for (const chainId of Object.keys(SUPPORTED).map(Number)) {
      expect(ids.has(chainId), chainLabel(chainId)).toBe(true);
    }
  }, 30_000);

  it('every token is still listed by Trails at that address', async () => {
    const trails = await trailsClient();
    const missing: string[] = [];
    for (const [chainId, tokens] of Object.entries(SUPPORTED)) {
      for (const token of tokens) {
        const res = await trails.getTokenList({
          chainIds: [Number(chainId)],
          tokenAddress: token.address,
          includeAllListed: true,
          includeExternal: true,
          limit: 5
        });
        const listed = (res.tokens ?? []).some(
          (t) => t.address.toLowerCase() === token.address.toLowerCase()
        );
        if (!listed)
          missing.push(`${token.symbol} ${token.address} on ${chainLabel(Number(chainId))}`);
      }
    }
    expect(missing).toEqual([]);
  }, 120_000);

  // Limits and spends are valued at the current price; a token without one
  // would block connecting on its chain.
  it('every non-stablecoin has a Trails USD price', async () => {
    const tokens = Object.entries(SUPPORTED).flatMap(([chainId, list]) =>
      list.filter((t) => t.kind !== 'usd').map((t) => ({ chainId: Number(chainId), ...t }))
    );
    const prices = await getUsdPrices(
      tokens.map((t) => ({ chainId: t.chainId, address: t.address }))
    );
    const unpriced = tokens
      .filter((t) => prices.get(priceKey({ chainId: t.chainId, address: t.address })) === undefined)
      .map((t) => `${t.symbol} on ${chainLabel(t.chainId)}`);
    expect(unpriced).toEqual([]);
  }, 60_000);
});

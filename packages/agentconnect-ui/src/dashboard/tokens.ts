// Token names and logos from the Trails token list, for the holdings list.

import { z } from 'zod/v4';

import { TRAILS_API_URL, USDC_POLYGON } from '@polygonlabs/agent-shared';

// Earn receipts (vault shares, aTokens) have no logo of their own; they show
// the stablecoin they hold.
const USDC = USDC_POLYGON.toLowerCase();
const USDT = '0xc2132d05d31c914a87c6611c10748aeb04b58e8f';

export interface TokenLook {
  name: string;
  logo?: string;
}

// A loose object naming only what is read below.
const TokenListBody = z.looseObject({
  tokens: z.array(z.looseObject({ name: z.string(), logoUri: z.string().optional() })).optional()
});

const cache = new Map<string, Promise<TokenLook | null>>();

function lookup(chainId: number, address: string): Promise<TokenLook | null> {
  const key = `${chainId}:${address}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = fetch(`${TRAILS_API_URL}/GetTokenList`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chainIds: [chainId], tokenAddress: address, includeAllListed: true })
    })
      .then((r) => (r.ok ? r.json() : null))
      // A reply that doesn't parse throws into the catch below: no look for this token.
      .then((body) => {
        const t = TokenListBody.nullable().parse(body)?.tokens?.[0];
        return t ? { name: t.name, logo: t.logoUri || undefined } : null;
      })
      .catch(() => null);
    cache.set(key, hit);
  }
  return hit;
}

/** Name and logo per token address (lowercase). Tokens Trails doesn't list are left out. */
export async function fetchTokenLooks(
  chainId: number,
  tokens: { address: string; symbol: string; name: string }[]
): Promise<Record<string, TokenLook>> {
  const [usdc, usdt, ...looks] = await Promise.all([
    lookup(chainId, USDC),
    lookup(chainId, USDT),
    ...tokens.map((t) => lookup(chainId, t.address))
  ]);
  const out: Record<string, TokenLook> = {};
  tokens.forEach((t, i) => {
    const look = looks[i];
    const backing = /USDT/i.test(t.symbol) ? usdt : /USDC/i.test(t.symbol) ? usdc : null;
    const logo = look?.logo ?? backing?.logo;
    if (look || logo) out[t.address] = { name: look?.name ?? t.name, logo };
  });
  return out;
}

// Token names and logos from the Trails token list, for the holdings list.

const TRAILS = 'https://trails-api.sequence.app/rpc/Trails';

// Earn receipts (vault shares, aTokens) have no logo of their own; they show
// the stablecoin they hold.
const USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
const USDT = '0xc2132d05d31c914a87c6611c10748aeb04b58e8f';

export interface TokenLook {
  name: string;
  logo?: string;
}

const cache = new Map<string, Promise<TokenLook | null>>();

function lookup(chainId: number, address: string): Promise<TokenLook | null> {
  const key = `${chainId}:${address}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = fetch(`${TRAILS}/GetTokenList`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chainIds: [chainId], tokenAddress: address, includeAllListed: true })
    })
      .then(
        (r) =>
          (r.ok ? r.json() : null) as Promise<{
            tokens?: { name: string; logoUri?: string }[];
          } | null>
      )
      .then((body) => {
        const t = body?.tokens?.[0];
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

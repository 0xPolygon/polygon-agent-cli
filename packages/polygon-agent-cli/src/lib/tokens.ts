// Token lookup by symbol for commands that take --symbol / --from / --to:
// native coins, the TRAILS_TOKEN_MAP_JSON override, then the token directory.

import { resolveErc20BySymbol } from './token-directory.ts';

// Load optional token map override from env
function loadTokenMap(): Record<string, Record<string, { address: string; decimals: number }>> {
  const raw = process.env.TRAILS_TOKEN_MAP_JSON || '';
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid TRAILS_TOKEN_MAP_JSON (must be valid JSON)');
  }
}

// Helper: Get token configuration (native or ERC20)
export async function getTokenConfig({
  chainId,
  symbol,
  nativeSymbol
}: {
  chainId: number;
  symbol: string;
  nativeSymbol: string;
}): Promise<{ symbol: string; address: string; decimals: number }> {
  const sym = String(symbol || '')
    .toUpperCase()
    .trim();

  // MATIC is POL's old name, and only means the native coin where POL is it.
  const native = nativeSymbol.toUpperCase();
  if (sym === 'NATIVE' || sym === native || (sym === 'MATIC' && native === 'POL')) {
    return {
      symbol: nativeSymbol.toUpperCase(),
      address: '0x0000000000000000000000000000000000000000',
      decimals: 18
    };
  }

  const tokenMap = loadTokenMap();
  const entry = tokenMap?.[String(chainId)]?.[sym];
  if (entry?.address && entry.decimals != null) {
    return {
      symbol: sym,
      address: entry.address,
      decimals: Number(entry.decimals)
    };
  }

  const token = await resolveErc20BySymbol({ chainId, symbol: sym });
  if (!token?.address || token.decimals == null) {
    throw new Error(`Unknown token ${sym} on chainId=${chainId}`);
  }

  return {
    symbol: sym,
    address: token.address,
    decimals: Number(token.decimals)
  };
}

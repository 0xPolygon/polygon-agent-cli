// What a token name means for a price (FS §8.1): a symbol without --chain is
// priced on its canonical chain (ETH on Ethereum, POL on Polygon, …); anything
// else needs a chain, where it resolves through the reviewed table, the native
// coin, or Trails' token list.

import { getAddress, isAddress } from 'viem';

import { findNetworkById } from '@polygonlabs/oms-wallet';

import type { PriceQuery } from './prices.ts';
import type { TokenKind } from './session/tokens.ts';

import { CliError } from './errors.ts';
import { canonicalPriceToken } from './prices.ts';
import { resolvePlanToken } from './session/resolve.ts';
import {
  chainLabel,
  findSupportedToken,
  parseChain,
  resolveSupportedSymbol,
  supportedChainIds,
  supportedTokens
} from './session/tokens.ts';
import { resolveNetwork } from './utils.ts';

const NATIVE = '0x0000000000000000000000000000000000000000';

export interface PriceTarget extends PriceQuery {
  symbol: string;
  // The chain the user named; absent when the symbol's canonical chain is used.
  chain?: number;
}

// A chain id, alias or network name; invalid_input otherwise.
export function chainIdFor(value: string): number {
  const alias = parseChain(value);
  if (alias !== undefined && findNetworkById(alias) !== undefined) return alias;
  try {
    return resolveNetwork(alias ?? value).chainId;
  } catch {
    throw new CliError({ code: 'invalid_input', message: `Unknown chain "${value}".` });
  }
}

function nativeSymbol(chainId: number): string | undefined {
  try {
    return resolveNetwork(chainId).nativeToken?.symbol?.toUpperCase();
  } catch {
    return undefined;
  }
}

export async function resolvePriceTarget(params: {
  token: string;
  chain?: string;
}): Promise<PriceTarget> {
  const token = params.token.trim();
  if (params.chain === undefined) {
    const canonical = canonicalPriceToken(token);
    if (canonical) {
      // The table's spelling where it has one (cbBTC), else upper case.
      const symbol =
        supportedTokens(1).find((t) => t.symbol.toUpperCase() === token.toUpperCase())?.symbol ??
        token.toUpperCase();
      return { symbol, ...canonical };
    }
    throw new CliError({
      code: 'chain_required',
      message: `Which chain is "${token}" on? Add --chain, e.g. --chain polygon.`
    });
  }
  const chainId = chainIdFor(params.chain);
  if (isAddress(token)) {
    const known = findSupportedToken({ chainId, address: token });
    return { symbol: known?.symbol ?? token, chainId, address: getAddress(token), chain: chainId };
  }
  const supported = resolveSupportedSymbol({ chainId, symbol: token });
  if (supported) {
    return { symbol: supported.symbol, chainId, address: supported.address, chain: chainId };
  }
  if (token.toUpperCase() === nativeSymbol(chainId) || token.toUpperCase() === 'NATIVE') {
    return { symbol: token.toUpperCase(), chainId, address: NATIVE, chain: chainId };
  }
  const listed = await resolvePlanToken({ chainId, token });
  return { symbol: listed.symbol, chainId, address: listed.address, chain: chainId };
}

const ASSET_KIND: Readonly<Record<string, TokenKind>> = {
  ETH: 'eth',
  WETH: 'eth',
  BTC: 'btc',
  WBTC: 'btc',
  CBBTC: 'btc',
  POL: 'pol',
  WPOL: 'pol'
};

// For a canonical symbol, the covered tokens of the same asset on each
// supported chain (ETH → WETH on Polygon, Base, …), so their prices can be shown.
export function relatedPriceTokens(
  target: PriceTarget
): Array<PriceQuery & { symbol: string; chainName: string }> {
  if (target.chain !== undefined) return [];
  const symbol = target.symbol.toUpperCase();
  const kind = ASSET_KIND[symbol];
  return supportedChainIds().flatMap((chainId) =>
    supportedTokens(chainId)
      .filter((t) => (kind ? t.kind === kind : t.symbol.toUpperCase() === symbol))
      .map((t) => ({
        chainId,
        address: t.address,
        symbol: t.symbol,
        chainName: chainLabel(chainId)
      }))
  );
}

// Resolving a token the user names (a symbol or an address) on a chain, for
// `wallet allowance set --add` and `wallet withdraw`. The reviewed table wins;
// anything else comes from Trails' token list, so the plan shows the exact
// contract the owner approves.

import { getAddress, isAddress } from 'viem';

import type { PlanToken } from './plan.ts';

import { CliError } from '../errors.ts';
import { trailsClient } from '../prices.ts';
import { chainLabel, parseChain, resolveSupportedSymbol, supportedChainIds } from './tokens.ts';

export function requireSupportedChain(value: string): number {
  const chainId = parseChain(value);
  if (chainId === undefined || !supportedChainIds().includes(chainId)) {
    throw new CliError({
      code: 'invalid_input',
      message: `Unsupported chain "${value}". Supported: ${supportedChainIds().map(chainLabel).join(', ')}.`
    });
  }
  return chainId;
}

export async function resolvePlanToken(params: {
  chainId: number;
  token: string;
}): Promise<PlanToken> {
  const supported = resolveSupportedSymbol({ chainId: params.chainId, symbol: params.token });
  if (supported) return { chainId: params.chainId, ...supported };

  const trails = await trailsClient();
  const byAddress = isAddress(params.token);
  const res = await trails.getTokenList({
    chainIds: [params.chainId],
    includeAllListed: true,
    // A symbol search sticks to listed tokens, so a look-alike can't be picked;
    // an exact address may be any token Trails knows.
    includeExternal: byAddress,
    limit: 20,
    ...(byAddress ? { tokenAddress: params.token } : { searchQuery: params.token })
  });
  const match = (res.tokens ?? []).find((token) =>
    byAddress
      ? token.address.toLowerCase() === params.token.toLowerCase()
      : token.symbol.toLowerCase() === params.token.toLowerCase()
  );
  if (!match || /^0x0{40}$/i.test(match.address)) {
    throw new CliError({
      code: 'invalid_input',
      message: `Couldn't find token "${params.token}" on ${chainLabel(params.chainId)}. Use its contract address.`
    });
  }
  return {
    chainId: params.chainId,
    symbol: match.symbol,
    address: getAddress(match.address),
    decimals: match.decimals
  };
}

// "<token>" or "<token>@<chain>". Without a chain, the token must be meant for
// the only chain in play.
export function parseTokenAtChain(params: { value: string; defaultChainIds: number[] }): {
  token: string;
  chainId: number;
} {
  const [token, chain] = params.value.split('@');
  if (chain) return { token: token.trim(), chainId: requireSupportedChain(chain) };
  if (params.defaultChainIds.length === 1)
    return { token: token.trim(), chainId: params.defaultChainIds[0] };
  throw new CliError({
    code: 'chain_required',
    message: `Which chain is "${token}" on? Use ${token}@<chain>, e.g. ${token}@polygon.`
  });
}

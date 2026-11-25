// The chains and tokens a connection's allowance covers: the same reviewed
// table as the CLI's session mode, shared through @polygonlabs/agent-shared.
// Native coins aren't there: a session can't spend them (OMS's native grant
// needs a fixed recipient).

import type { SupportedToken, TokenKind } from '@polygonlabs/agent-shared';

import { BUY_ALIAS, HOME_CHAINS, SUPPORTED } from '@polygonlabs/agent-shared';
import { findNetworkById } from '@polygonlabs/oms-wallet';

export { BUY_ALIAS, HOME_CHAINS, SUPPORTED };
export type { SupportedToken, TokenKind };

export function supportedChainIds(): number[] {
  return Object.keys(SUPPORTED)
    .map(Number)
    .filter((chainId) => findNetworkById(chainId) !== undefined);
}

export function supportedTokens(chainId: number): readonly SupportedToken[] {
  return SUPPORTED[chainId] ?? [];
}

export function findSupportedToken(params: {
  chainId: number;
  address: string;
}): SupportedToken | undefined {
  const address = params.address.toLowerCase();
  return supportedTokens(params.chainId).find((token) => token.address.toLowerCase() === address);
}

// A symbol on a chain: an exact table symbol, or a BUY_ALIAS kind (first match).
export function resolveSupportedSymbol(params: {
  chainId: number;
  symbol: string;
}): SupportedToken | undefined {
  const symbol = params.symbol.toUpperCase();
  const tokens = supportedTokens(params.chainId);
  const exact = tokens.find((token) => token.symbol.toUpperCase() === symbol);
  if (exact) return exact;
  const kind = BUY_ALIAS[symbol];
  return kind ? tokens.find((token) => token.kind === kind) : undefined;
}

// Polygon and Base, plus any supported chain where the wallet holds a covered token.
export function defaultPlanChains(heldChainIds: Iterable<number>): number[] {
  const supported = new Set(supportedChainIds());
  const chains = [...HOME_CHAINS];
  for (const chainId of heldChainIds) {
    if (supported.has(chainId) && !chains.includes(chainId)) chains.push(chainId);
  }
  return chains;
}

export function chainLabel(chainId: number): string {
  return findNetworkById(chainId)?.displayName ?? `chain ${chainId}`;
}

// Accepts a chain id, an OMS network name (polygon, base, mainnet, bsc…) or a
// display name (Ethereum, BNB Chain…), case-insensitively.
const CHAIN_ALIASES: Readonly<Record<string, number>> = {
  ethereum: 1,
  eth: 1,
  mainnet: 1,
  polygon: 137,
  matic: 137,
  base: 8453,
  arbitrum: 42161,
  arb: 42161,
  optimism: 10,
  op: 10,
  bnb: 56,
  bsc: 56,
  'bnb-chain': 56,
  avalanche: 43114,
  avax: 43114,
  'arbitrum-nova': 42170,
  nova: 42170,
  katana: 747474
};

export function parseChain(value: string): number | undefined {
  const trimmed = value.trim().toLowerCase();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return CHAIN_ALIASES[trimmed];
}

// The chains and tokens session mode covers by default: a reviewed table of
// canonical contracts, not picked at run time (Trails lists several entries per
// symbol on some chains, e.g. native and bridged USDC). tokens.network.test.ts
// checks it against Trails' live lists.
//
// Chains are those both Trails and OMS Wallets support. Native coins aren't
// here: a session can't spend them (OMS's native grant needs a fixed recipient).

import type { Address } from 'viem';

import { getAddress } from 'viem';

import { findNetworkById } from '@polygonlabs/oms-wallet';

export type TokenKind = 'usd' | 'eth' | 'btc' | 'pol';

export interface SupportedToken {
  symbol: string;
  kind: TokenKind;
  address: Address;
  decimals: number;
}

const t = (symbol: string, kind: TokenKind, address: string, decimals: number): SupportedToken => ({
  symbol,
  kind,
  address: getAddress(address),
  decimals
});

// Keyed by chain id. Addresses as listed by Trails on 2026-10-06.
export const SUPPORTED: Readonly<Record<number, readonly SupportedToken[]>> = {
  // Polygon (home)
  137: [
    t('USDC', 'usd', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', 6),
    t('USDT', 'usd', '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', 6),
    t('WETH', 'eth', '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619', 18),
    t('WBTC', 'btc', '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6', 8),
    t('WPOL', 'pol', '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', 18)
  ],
  // Base
  8453: [
    t('USDC', 'usd', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 6),
    t('USDT', 'usd', '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', 6),
    t('WETH', 'eth', '0x4200000000000000000000000000000000000006', 18),
    t('cbBTC', 'btc', '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', 8)
  ],
  // Ethereum
  1: [
    t('USDC', 'usd', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 6),
    t('USDT', 'usd', '0xdac17f958d2ee523a2206206994597c13d831ec7', 6),
    t('USDG', 'usd', '0xe343167631d89b6ffc58b88d6b7fb0228795491d', 6),
    t('WETH', 'eth', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 18),
    t('WBTC', 'btc', '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', 8),
    t('cbBTC', 'btc', '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', 8),
    t('POL', 'pol', '0x455e53cbb86018ac2b8092fdcd39d8444affc3f6', 18)
  ],
  // Arbitrum
  42161: [
    t('USDC', 'usd', '0xaf88d065e77c8cc2239327c5edb3a432268e5831', 6),
    t('USDT0', 'usd', '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', 6),
    t('WETH', 'eth', '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', 18),
    t('WBTC', 'btc', '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f', 8),
    t('cbBTC', 'btc', '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', 8)
    // No POL: Trails has no price for bridged POL here, so it could be
    // neither limited nor spent.
  ],
  // Optimism
  10: [
    t('USDC', 'usd', '0x0b2c639c533813f4aa9d7837caf62653d097ff85', 6),
    t('USDT', 'usd', '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', 6),
    t('WETH', 'eth', '0x4200000000000000000000000000000000000006', 18),
    t('WBTC', 'btc', '0x68f180fcce6836688e9084f035309e29bf0a2095', 8)
  ],
  // BNB Chain (its USDC has 18 decimals)
  56: [
    t('USDC', 'usd', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', 18),
    t('ETH', 'eth', '0x2170ed0880ac9a755fd29b2688956bd959f933f8', 18),
    t('WBTC', 'btc', '0x0555e30da8f98308edb960aa94c0db47230d2b9c', 8)
  ],
  // Avalanche
  43114: [
    t('USDC', 'usd', '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', 6),
    t('USDT', 'usd', '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7', 6)
  ],
  // Arbitrum Nova
  42170: [
    t('USDC', 'usd', '0x750ba8b76187092b0d1e87e28daaf484d1b5273b', 6),
    t('USDT', 'usd', '0x52484e1ab2e2b22420a25c20fa49e173a26202cd', 6),
    t('WETH', 'eth', '0x722e8bdd2ce80a4422e880164f2079488e115365', 18),
    t('WBTC', 'btc', '0x1d05e4e72cd994cdf976181cfb0707345763564d', 8)
  ],
  // Katana
  747474: [
    t('USDC', 'usd', '0x203a662b0bd271a6ed5a60edfbd04bfce608fd36', 6),
    t('USDT', 'usd', '0x2dca96907fde857dd3d816880a0df407eeb2d2f2', 6),
    t('WETH', 'eth', '0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62', 18),
    t('WBTC', 'btc', '0x0913da6da4b42f538b445599b46bb4622342cf52', 8),
    t('POL', 'pol', '0xb24e3035d1fcbc0e43cf3143c3fd92e53df2009b', 18)
  ]
};

// Buying "ETH", "BTC" or "POL" delivers that chain's token of the kind.
export const BUY_ALIAS: Readonly<Record<string, TokenKind>> = {
  ETH: 'eth',
  BTC: 'btc',
  POL: 'pol'
};

export const HOME_CHAINS: readonly number[] = [137, 8453];

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

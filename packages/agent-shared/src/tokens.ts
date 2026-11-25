// The chains and tokens session mode covers by default: a reviewed table of
// canonical contracts, not picked at run time (Trails lists several entries per
// symbol on some chains, e.g. native and bridged USDC). The CLI's
// tokens.network.test.ts checks it against Trails' live lists.
//
// Chains are those both Trails and OMS Wallets support. Native coins aren't
// here: a session can't spend them (OMS's native grant needs a fixed recipient).

import type { Address } from 'viem';

export type TokenKind = 'usd' | 'eth' | 'btc' | 'pol';

export interface SupportedToken {
  symbol: string;
  kind: TokenKind;
  address: Address;
  decimals: number;
}

const t = (
  symbol: string,
  kind: TokenKind,
  address: Address,
  decimals: number
): SupportedToken => ({
  symbol,
  kind,
  address,
  decimals
});

// Keyed by chain id. Addresses as listed by Trails on 2026-10-06.
export const SUPPORTED: Readonly<Record<number, readonly SupportedToken[]>> = {
  // Polygon (home)
  137: [
    t('USDC', 'usd', '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 6),
    t('USDT', 'usd', '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6),
    t('WETH', 'eth', '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', 18),
    t('WBTC', 'btc', '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', 8),
    t('WPOL', 'pol', '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', 18)
  ],
  // Base
  8453: [
    t('USDC', 'usd', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6),
    t('USDT', 'usd', '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 6),
    t('WETH', 'eth', '0x4200000000000000000000000000000000000006', 18),
    t('cbBTC', 'btc', '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 8)
  ],
  // Ethereum
  1: [
    t('USDC', 'usd', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6),
    t('USDT', 'usd', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6),
    t('USDG', 'usd', '0xe343167631d89B6Ffc58B88d6b7fB0228795491D', 6),
    t('WETH', 'eth', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 18),
    t('WBTC', 'btc', '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 8),
    t('cbBTC', 'btc', '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 8),
    t('POL', 'pol', '0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6', 18)
  ],
  // Arbitrum
  42161: [
    t('USDC', 'usd', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6),
    t('USDT0', 'usd', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6),
    t('WETH', 'eth', '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 18),
    t('WBTC', 'btc', '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', 8),
    t('cbBTC', 'btc', '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 8)
    // No POL: Trails has no price for bridged POL here, so it could be
    // neither limited nor spent.
  ],
  // Optimism
  10: [
    t('USDC', 'usd', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6),
    t('USDT', 'usd', '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 6),
    t('WETH', 'eth', '0x4200000000000000000000000000000000000006', 18),
    t('WBTC', 'btc', '0x68f180fcCe6836688e9084f035309E29Bf0A2095', 8)
  ],
  // BNB Chain (its USDC has 18 decimals)
  56: [
    t('USDC', 'usd', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18),
    t('ETH', 'eth', '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', 18),
    t('WBTC', 'btc', '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c', 8)
  ],
  // Avalanche
  43114: [
    t('USDC', 'usd', '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', 6),
    t('USDT', 'usd', '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', 6)
  ],
  // Arbitrum Nova
  42170: [
    t('USDC', 'usd', '0x750ba8b76187092B0D1E87E28daaf484d1b5273b', 6),
    t('USDT', 'usd', '0x52484E1ab2e2B22420a25c20FA49E173a26202Cd', 6),
    t('WETH', 'eth', '0x722E8BdD2ce80A4422E880164f2079488e115365', 18),
    t('WBTC', 'btc', '0x1d05e4e72cD994cdF976181CfB0707345763564d', 8)
  ],
  // Katana
  747474: [
    t('USDC', 'usd', '0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36', 6),
    t('USDT', 'usd', '0x2DCa96907fde857dd3D816880A0df407eeB2D2F2', 6),
    t('WETH', 'eth', '0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62', 18),
    t('WBTC', 'btc', '0x0913DA6Da4b42f538B445599b46Bb4622342Cf52', 8),
    t('POL', 'pol', '0xb24e3035d1FCBC0E43CF3143C3Fd92E53df2009b', 18)
  ]
};

// Buying "ETH", "BTC" or "POL" delivers that chain's token of the kind.
export const BUY_ALIAS: Readonly<Record<string, TokenKind>> = {
  ETH: 'eth',
  BTC: 'btc',
  POL: 'pol'
};

export const HOME_CHAINS: readonly number[] = [137, 8453];

import { describe, expect, it } from 'vitest';

import { findNetworkById } from '@polygonlabs/oms-wallet';

import {
  BUY_ALIAS,
  SUPPORTED,
  defaultPlanChains,
  findSupportedToken,
  parseChain,
  resolveSupportedSymbol,
  supportedChainIds
} from './tokens.ts';

describe('supported table', () => {
  it('only has chains the OMS SDK supports (the nine mainnets)', () => {
    const chains = Object.keys(SUPPORTED).map(Number);
    expect(chains.sort((a, b) => a - b)).toEqual([
      1, 10, 56, 137, 8453, 42161, 42170, 43114, 747474
    ]);
    for (const chainId of chains) expect(findNetworkById(chainId), String(chainId)).toBeDefined();
    expect(supportedChainIds().sort((a, b) => a - b)).toEqual(chains.sort((a, b) => a - b));
  });

  it('has no duplicate token or symbol on a chain, and no native coins', () => {
    for (const [chainId, tokens] of Object.entries(SUPPORTED)) {
      const addresses = tokens.map((t) => t.address.toLowerCase());
      expect(new Set(addresses).size, chainId).toBe(addresses.length);
      expect(new Set(tokens.map((t) => t.symbol)).size, chainId).toBe(tokens.length);
      expect(addresses).not.toContain('0x0000000000000000000000000000000000000000');
    }
  });

  it('covers a stablecoin on every chain', () => {
    for (const [chainId, tokens] of Object.entries(SUPPORTED)) {
      expect(
        tokens.some((t) => t.kind === 'usd'),
        chainId
      ).toBe(true);
    }
  });

  it('resolves BUY_ALIAS to the chain token of that kind, or not at all', () => {
    expect(resolveSupportedSymbol({ chainId: 137, symbol: 'ETH' })?.symbol).toBe('WETH');
    expect(resolveSupportedSymbol({ chainId: 137, symbol: 'POL' })?.symbol).toBe('WPOL');
    expect(resolveSupportedSymbol({ chainId: 137, symbol: 'btc' })?.symbol).toBe('WBTC');
    expect(resolveSupportedSymbol({ chainId: 8453, symbol: 'BTC' })?.symbol).toBe('cbBTC');
    expect(resolveSupportedSymbol({ chainId: 56, symbol: 'ETH' })?.symbol).toBe('ETH');
    expect(resolveSupportedSymbol({ chainId: 8453, symbol: 'POL' })).toBeUndefined();
    expect(resolveSupportedSymbol({ chainId: 43114, symbol: 'ETH' })).toBeUndefined();
    for (const [chainId, tokens] of Object.entries(SUPPORTED)) {
      for (const [alias, kind] of Object.entries(BUY_ALIAS)) {
        const resolved = resolveSupportedSymbol({ chainId: Number(chainId), symbol: alias });
        expect(resolved?.kind, `${alias} on ${chainId}`).toBe(
          tokens.some((t) => t.kind === kind) ? kind : undefined
        );
      }
    }
  });

  it('finds tokens by address case-insensitively', () => {
    expect(
      findSupportedToken({ chainId: 137, address: '0x3C499C542CEF5E3811E1192CE70D8CC03D5C3359' })
        ?.symbol
    ).toBe('USDC');
  });
});

describe('defaultPlanChains', () => {
  it('is Polygon and Base, plus supported chains already holding covered tokens', () => {
    expect(defaultPlanChains([])).toEqual([137, 8453]);
    expect(defaultPlanChains([42161, 137, 999999])).toEqual([137, 8453, 42161]);
  });
});

describe('parseChain', () => {
  it.each([
    ['polygon', 137],
    ['Base', 8453],
    ['ethereum', 1],
    ['bnb', 56],
    ['arbitrum-nova', 42170],
    ['747474', 747474],
    ['solana', undefined]
  ])('%s → %s', (value, chainId) => {
    expect(parseChain(value)).toBe(chainId);
  });
});

import { describe, expect, it } from 'vitest';

import { relatedPriceTokens, resolvePriceTarget } from './price-target.ts';

const NATIVE = '0x0000000000000000000000000000000000000000';

describe('resolvePriceTarget', () => {
  it('prices a canonical symbol on its home chain', async () => {
    expect(await resolvePriceTarget({ token: 'eth' })).toMatchObject({
      symbol: 'ETH',
      chainId: 1,
      address: NATIVE
    });
    expect(await resolvePriceTarget({ token: 'POL' })).toMatchObject({
      chainId: 137,
      address: NATIVE
    });
    expect(await resolvePriceTarget({ token: 'cbBTC' })).toMatchObject({
      chainId: 1,
      address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'
    });
  });

  it('asks for a chain for anything else', async () => {
    await expect(resolvePriceTarget({ token: 'PEPE' })).rejects.toMatchObject({
      code: 'chain_required'
    });
    await expect(
      resolvePriceTarget({ token: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619' })
    ).rejects.toMatchObject({ code: 'chain_required' });
  });

  it('with a chain: the reviewed table, then the native coin', async () => {
    expect(await resolvePriceTarget({ token: 'ETH', chain: 'base' })).toMatchObject({
      symbol: 'WETH',
      chainId: 8453,
      chain: 8453
    });
    expect(await resolvePriceTarget({ token: 'AVAX', chain: 'avalanche' })).toMatchObject({
      chainId: 43114,
      address: NATIVE
    });
  });

  it('refuses an unknown chain', async () => {
    await expect(resolvePriceTarget({ token: 'ETH', chain: 'nowhere' })).rejects.toMatchObject({
      code: 'invalid_input'
    });
  });
});

describe('relatedPriceTokens', () => {
  it('lists the covered tokens of the same asset per chain', async () => {
    const related = relatedPriceTokens(await resolvePriceTarget({ token: 'ETH' }));
    expect(related.map((t) => `${t.symbol}@${t.chainId}`)).toEqual(
      expect.arrayContaining(['WETH@137', 'WETH@8453', 'ETH@56'])
    );
    expect(relatedPriceTokens(await resolvePriceTarget({ token: 'ETH', chain: 'base' }))).toEqual(
      []
    );
  });
});

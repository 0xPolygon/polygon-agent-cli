import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';

import { BUY_ALIAS, HOME_CHAINS, SUPPORTED, TRAILS_API_URL, USDC_POLYGON } from './index.ts';

describe('token table', () => {
  it('has every home chain and well-formed addresses', () => {
    for (const chainId of HOME_CHAINS) expect(SUPPORTED[chainId]).toBeDefined();
    for (const tokens of Object.values(SUPPORTED)) {
      for (const token of tokens) expect(token.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it('writes every address in its checksummed form', () => {
    for (const tokens of Object.values(SUPPORTED)) {
      for (const token of tokens) expect(token.address).toBe(getAddress(token.address));
    }
  });

  it('resolves every buy alias to a kind some chain carries', () => {
    const kinds = new Set(Object.values(SUPPORTED).flatMap((tokens) => tokens.map((t) => t.kind)));
    for (const kind of Object.values(BUY_ALIAS)) expect(kinds.has(kind)).toBe(true);
  });
});

describe('constants', () => {
  it('USDC_POLYGON is the USDC entry in the Polygon table', () => {
    const usdc = SUPPORTED[137]?.find((t) => t.symbol === 'USDC');
    expect(usdc?.address).toBe(USDC_POLYGON);
  });

  it('TRAILS_API_URL has no trailing slash', () => {
    expect(TRAILS_API_URL.endsWith('/')).toBe(false);
  });
});

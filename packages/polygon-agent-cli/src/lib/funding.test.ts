import { afterEach, describe, expect, it, vi } from 'vitest';

import { fundingUrl } from './funding.ts';

describe('fundingUrl', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('adds amount only when given', () => {
    vi.stubEnv('POLYGON_AGENT_FUNDING_UI', 'https://fund.example/');
    expect(fundingUrl({ walletAddress: '0xabc', chainId: 137 })).toBe(
      'https://fund.example/?wallet=0xabc&chain=137&view=fund'
    );
    expect(fundingUrl({ walletAddress: '0xabc', chainId: 137, amountUsd: '5' })).toBe(
      'https://fund.example/?wallet=0xabc&chain=137&view=fund&amount=5'
    );
  });
});

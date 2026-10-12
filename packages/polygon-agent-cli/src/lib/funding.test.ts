import { afterEach, describe, expect, it, vi } from 'vitest';

import { dashboardInfo, fundingUrl } from './funding.ts';

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

  it('takes a view', () => {
    vi.stubEnv('POLYGON_AGENT_FUNDING_UI', 'https://fund.example');
    expect(fundingUrl({ walletAddress: '0xabc', chainId: 137, view: 'dashboard' })).toBe(
      'https://fund.example/?wallet=0xabc&chain=137&view=dashboard'
    );
  });
});

describe('dashboardInfo', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('opens on the fund view for an empty wallet', () => {
    vi.stubEnv('POLYGON_AGENT_FUNDING_UI', 'https://fund.example');
    expect(dashboardInfo({ walletAddress: '0xabc', funded: false })).toEqual({
      url: 'https://fund.example/?wallet=0xabc&chain=137&view=fund'
    });
  });

  it('opens on the dashboard view for a funded wallet', () => {
    vi.stubEnv('POLYGON_AGENT_FUNDING_UI', 'https://fund.example');
    expect(dashboardInfo({ walletAddress: '0xabc', funded: true })).toEqual({
      url: 'https://fund.example/?wallet=0xabc&chain=137&view=dashboard'
    });
  });
});

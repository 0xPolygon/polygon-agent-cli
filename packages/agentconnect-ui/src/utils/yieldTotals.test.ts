import { describe, expect, it } from 'vitest';

import type { Holding } from '../indexer';

import { sum } from './holdings.js';
import { dustLabel, earningTotal, vaultAssets, yearlyAt } from './yieldTotals.js';

describe('vaultAssets', () => {
  it('is null until the balances load', () => {
    expect(vaultAssets(null)).toBeNull();
  });

  it('rounds each vault to cents so the total equals the sum of what is shown', () => {
    const assets = vaultAssets({ '0xaaaa': 10.004, '0xbbbb': 10.004, '0xcccc': 0.006 });
    expect(assets?.byVault).toEqual({ '0xaaaa': 10, '0xbbbb': 10, '0xcccc': 0.01 });
    expect(assets?.total).toBe(20.01);
  });

  it('rounds each vault before summing, so every page shows the same total', () => {
    expect(vaultAssets({ '0xaaaa': 10.125, '0xbbbb': 10.125 })?.total).toBe(20.26);
  });

  it('is zero when nothing is deposited', () => {
    expect(vaultAssets({ '0xaaaa': 0 })?.total).toBe(0);
    expect(vaultAssets({})?.total).toBe(0);
  });
});

describe('earningTotal', () => {
  it('waits for the Polygon holdings', () => {
    expect(earningTotal({ polygon: null, vaults: 5, vaultsSettled: true })).toBeNull();
  });

  it('waits for the vault balances unless they settled by failing', () => {
    expect(earningTotal({ polygon: 3, vaults: null, vaultsSettled: false })).toBeNull();
    expect(earningTotal({ polygon: 3.456, vaults: null, vaultsSettled: true })).toBe(3.46);
  });

  it('adds the two parts after rounding each to cents', () => {
    expect(earningTotal({ polygon: 1.004, vaults: 2.01, vaultsSettled: true })).toBe(3.01);
  });
});

describe('yearlyAt', () => {
  it('applies a percent rate and rounds to cents', () => {
    expect(yearlyAt(1000, 1.76)).toBe(17.6);
    expect(yearlyAt(333.33, 3)).toBe(10);
  });

  it('uses the rate as displayed, to two decimals', () => {
    expect(yearlyAt(1000, 2.1838)).toBe(21.8);
  });
});

const holding = (kind: Holding['kind'], usd: number): Holding => ({
  address: '0x1111111111111111111111111111111111111111',
  symbol: 'TKN',
  name: 'Token',
  qty: 1,
  usd,
  kind
});

describe('earning on Overview and Yield', () => {
  it('shows the same figure for fractional Polygon and vault balances', () => {
    const polygon = sum(
      [holding('earn', 5.555), holding('earn', 0.004), holding('spend', 3)],
      'earn'
    );
    const vaults = vaultAssets({ '0xaaaa': 10.125, '0xbbbb': 10.125 })?.total ?? null;
    const overview = earningTotal({ polygon, vaults, vaultsSettled: true });
    const yieldPage = earningTotal({ polygon, vaults, vaultsSettled: false });
    expect(overview).toBe(yieldPage);
    expect(overview).toBe(25.82);
  });
});

describe('dustLabel', () => {
  it('is null for zero, so the empty wording stays', () => {
    expect(dustLabel(0)).toBeNull();
  });

  it('labels a balance above zero that rounds to $0.00', () => {
    expect(dustLabel(0.003)).toBe('<$0.01');
  });

  it('is null from a cent up, where the amount itself is shown', () => {
    expect(dustLabel(0.005)).toBeNull();
    expect(dustLabel(12.5)).toBeNull();
  });
});

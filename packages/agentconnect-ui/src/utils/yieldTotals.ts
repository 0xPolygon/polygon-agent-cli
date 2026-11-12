import { roundCents } from './groupPositions.js';

export interface VaultAssets {
  total: number;
  byVault: Record<string, number>;
}

// Each vault is rounded to cents before summing, so the cards add up to the header.
export function vaultAssets(balances: Record<string, number> | null): VaultAssets | null {
  if (!balances) return null;
  const byVault = Object.fromEntries(
    Object.entries(balances).map(([address, usd]) => [address, roundCents(usd)])
  );
  return { total: roundCents(Object.values(byVault).reduce((s, v) => s + v, 0)), byVault };
}

interface EarningTotalInput {
  polygon: number | null;
  vaults: number | null;
  vaultsSettled: boolean;
}

// Unknown until the Polygon holdings load and the vault balances have loaded or failed.
export function earningTotal({ polygon, vaults, vaultsSettled }: EarningTotalInput): number | null {
  if (polygon === null || (vaults === null && !vaultsSettled)) return null;
  return roundCents(roundCents(polygon) + (vaults ?? 0));
}

// The rate is rounded to the two decimals the card shows, so the yearly figure can be reproduced from the screen.
export const yearlyAt = (total: number, apy: number) =>
  roundCents((total * (Math.round(apy * 100) / 100)) / 100);

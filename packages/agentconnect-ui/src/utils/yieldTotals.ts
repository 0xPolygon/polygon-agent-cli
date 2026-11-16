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

// A balance that is above zero but rounds to $0.00 would read as empty.
export const dustLabel = (raw: number) => (raw > 0 && roundCents(raw) === 0 ? '<$0.01' : null);

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

export interface RatedBalance {
  usd: number;
  apy: number | null;
}

// Each vault's yearly amount uses its own rate as displayed (two decimals) and is rounded to cents
// before summing, so the figure can be reproduced from the cards. A vault with no rate adds nothing.
export function yearlyFromVaults(vaults: RatedBalance[]): number {
  const cents = vaults.map(({ usd, apy }) =>
    apy === null ? 0 : roundCents((usd * (Math.round(apy * 100) / 100)) / 100)
  );
  return roundCents(cents.reduce((s, v) => s + v, 0));
}

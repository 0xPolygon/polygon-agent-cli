import { roundCents } from './groupPositions.js';
import { earningTotal } from './yieldTotals.js';

interface TotalBalanceInput {
  spend: number | null;
  earn: number | null;
  predictions: number | null;
  predictionsSettled: boolean;
  vaults: number | null;
  vaultsSettled: boolean;
}

// Sums the parts as the page prints them, so the headline matches the lines under it to the cent.
// Unknown until every part has loaded or failed, even if a provisional figure exists; a settled part with no value is $0.
export function totalBalance({
  spend,
  earn,
  predictions,
  predictionsSettled,
  vaults,
  vaultsSettled
}: TotalBalanceInput): number | null {
  const earning = earningTotal({ polygon: earn, vaults, vaultsSettled });
  if (spend === null || earning === null) return null;
  if (!predictionsSettled) return null;
  return roundCents(roundCents(spend) + (predictions ?? 0) + earning);
}

import type { Holding } from '../../indexer';
import type { Vault } from '../earn.js';
import type { Loadable } from '../types.js';

import { EmptyState } from '../../components/EmptyState.js';
import { Money } from '../../components/Money.js';
import { PromptsButton } from '../../components/PromptsButton.js';
import { sum } from '../../utils/holdings.js';
import { earningTotal, vaultAssets, yearlyAt } from '../../utils/yieldTotals.js';
import { HoldingsList } from './HoldingsList.js';
import { SECTION_TITLE } from './styles.js';
import { VaultCard } from './VaultCard.js';
import { VaultCardSkeleton } from './VaultCardSkeleton.js';
import { YieldHeader } from './YieldHeader.js';

interface YieldTabProps {
  holdings: Loadable<Holding[]>;
  vaults: Loadable<Vault[]>;
  vaultBalances: Loadable<Record<string, number>>;
  onDeposit: (vault: Vault) => void;
  onOpenPrompts: () => void;
}

export function YieldTab({
  holdings,
  vaults,
  vaultBalances,
  onDeposit,
  onOpenPrompts
}: YieldTabProps) {
  const assets = vaultAssets(vaultBalances.data);
  const vaultsFailed = !!(vaults.error || vaultBalances.error);
  const polygonEarn = holdings.data?.filter((h) => h.kind === 'earn') ?? [];
  const onPolygon = sum(holdings.data, 'earn');
  const everything = earningTotal({
    polygon: onPolygon,
    vaults: assets?.total ?? null,
    vaultsSettled: vaultsFailed
  });
  const prime = vaults.data?.[0];
  const atPrimeRate =
    prime && !holdings.error && !vaultsFailed && everything !== null && everything > 0
      ? { total: everything, yearly: yearlyAt(everything, prime.apy) }
      : null;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-2xl font-bold">Yield</h2>
        <PromptsButton onClick={onOpenPrompts} />
      </div>
      <div className="flex flex-col gap-4">
        <YieldHeader total={assets?.total ?? null} failed={vaultsFailed} />
        {(holdings.error || vaultsFailed) && (
          <span className="text-sm font-medium text-destructive">
            Couldn't load your balance. Refresh to try again.
          </span>
        )}
        {atPrimeRate && (
          <p className="m-0 text-sm text-muted">
            <Money value={atPrimeRate.total} className="font-bold text-primary" /> earning in total.
            At the Prime rate that's ≈ <Money value={atPrimeRate.yearly} /> a year.
          </p>
        )}
        {everything === 0 && !holdings.error && !vaultsFailed && (
          <p className="m-0 text-sm text-muted">Nothing deposited yet.</p>
        )}
      </div>

      {vaults.error ? (
        <EmptyState title="Couldn't load rates">Refresh the page to try again.</EmptyState>
      ) : vaults.data?.length === 0 ? (
        <EmptyState title="No vaults open right now">Check back soon.</EmptyState>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2 lg:gap-5">
          {vaults.data
            ? vaults.data.map((v) => (
                <VaultCard
                  key={v.address}
                  vault={v}
                  assets={assets?.byVault[v.address] ?? null}
                  failed={vaultsFailed}
                  onDeposit={onDeposit}
                  onTryAgent={onOpenPrompts}
                />
              ))
            : [0, 1].map((i) => <VaultCardSkeleton key={i} />)}
        </div>
      )}

      {onPolygon !== null && onPolygon > 0 && (
        <div className="flex flex-col gap-3">
          <span className={SECTION_TITLE}>Also earning on Polygon</span>
          <HoldingsList holdings={{ ...holdings, data: polygonEarn }} />
        </div>
      )}
    </div>
  );
}

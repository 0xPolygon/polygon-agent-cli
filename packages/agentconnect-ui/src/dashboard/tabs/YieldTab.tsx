import type { Holding } from '../../indexer';
import type { Vault } from '../earn.js';
import type { Loadable } from '../types.js';

import { EmptyState } from '../../components/EmptyState.js';
import { Money } from '../../components/Money.js';
import { PromptsButton } from '../../components/PromptsButton.js';
import { sum } from '../../utils/holdings.js';
import { dustLabel, earningTotal, vaultAssets, yearlyFromVaults } from '../../utils/yieldTotals.js';
import { HoldingsList } from './HoldingsList.js';
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
  const rawBalances = vaultBalances.data ?? {};
  const anyDust = Object.values(rawBalances).some((b) => dustLabel(b) !== null);
  const ratedVaults = (vaults.data ?? []).map((v) => ({
    usd: assets?.byVault[v.address] ?? 0,
    apy: v.apy
  }));
  const yearly = yearlyFromVaults(ratedVaults);
  // Lending positions and vaults missing from the rate list carry no rate here.
  const ratedUsd = ratedVaults.reduce((s, v) => s + v.usd, 0);
  const showTotal =
    !!vaults.data?.length &&
    !holdings.error &&
    !vaultsFailed &&
    everything !== null &&
    everything > 0;
  const partial = everything !== null && everything - ratedUsd >= 0.005;

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
        {showTotal && (
          <p className="m-0 text-sm text-muted">
            <Money value={everything} className="font-bold text-primary" /> earning in total.
            {yearly > 0 &&
              (partial ? (
                <>
                  {' '}
                  Your vault deposits earn ≈ <Money value={yearly} /> a year at today's rates.
                </>
              ) : (
                <>
                  {' '}
                  At today's rates that's ≈ <Money value={yearly} /> a year.
                </>
              ))}
          </p>
        )}
        {everything === 0 && !anyDust && !holdings.error && !vaultsFailed && (
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
                  dust={dustLabel(rawBalances[v.address] ?? 0)}
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
          <span className="text-lg font-bold">Also earning on Polygon</span>
          <HoldingsList holdings={{ ...holdings, data: polygonEarn }} />
        </div>
      )}
    </div>
  );
}

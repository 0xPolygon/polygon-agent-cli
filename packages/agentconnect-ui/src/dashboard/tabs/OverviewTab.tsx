import { ArrowDownLeft, ArrowUpRight, Bot, Plus } from 'lucide-react';

import { Button } from '@polygonlabs/design-system';

import type { Holding } from '../../indexer';
import type { Page } from '../AppSidebar.js';
import type { Loadable } from '../types.js';

import { Money } from '../../components/Money.js';
import { TotalAssetsHeader } from '../../components/TotalAssetsHeader.js';
import { sum } from '../../utils/holdings.js';
import { earningTotal } from '../../utils/yieldTotals.js';

interface OverviewTabProps {
  holdings: Loadable<Holding[]>;
  positionsValue: number | null;
  // Money in the Katana earn vaults (not in `holdings`, which is Polygon only).
  vaultsValue: number | null;
  earningApy: number | null;
  go: (page: Page) => void;
  onAdd: () => void;
  onWithdraw: () => void;
  onReceive: () => void;
  onTryAgent: () => void;
}

export function OverviewTab({
  holdings,
  positionsValue,
  vaultsValue,
  earningApy,
  go,
  onAdd,
  onWithdraw,
  onReceive,
  onTryAgent
}: OverviewTabProps) {
  const total = holdings.error ? null : sum(holdings.data);
  const totalWithPositions =
    total === null ? null : total + (positionsValue ?? 0) + (vaultsValue ?? 0);
  const earning = sum(holdings.data, 'earn');
  const buckets = [
    {
      label: 'Available to spend',
      value: sum(holdings.data, 'spend'),
      failed: holdings.error,
      note: null
    },
    { label: 'In predictions', value: positionsValue, failed: false, note: null },
    {
      label: 'Earning',
      value: earningTotal({ polygon: earning, vaults: vaultsValue, vaultsSettled: true }),
      failed: holdings.error,
      note: earningApy === null ? null : `${earningApy.toFixed(2)}% APY`
    }
  ];
  const actions = [
    { label: 'Add money', icon: Plus, onClick: onAdd },
    { label: 'Withdraw money', icon: ArrowUpRight, onClick: onWithdraw },
    { label: 'Receive money', icon: ArrowDownLeft, onClick: onReceive },
    { label: 'Try with your agent', icon: Bot, onClick: onTryAgent }
  ];
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-10">
        <TotalAssetsHeader
          label="Balance"
          total={totalWithPositions}
          failed={holdings.error}
          listClassName="gap-3"
          figureClassName="leading-[1.1]"
          note={
            holdings.error && (
              <span className="text-sm text-destructive font-medium">
                Couldn't load your balance. Refresh to try again.
              </span>
            )
          }
        >
          {buckets.map((b) => (
            <div key={b.label} className="flex items-baseline gap-1">
              <dt className="text-sm font-medium">
                {b.label}
                {b.note && <span className="ml-2 text-xs font-medium text-muted">{b.note}</span>}
              </dt>
              <span
                aria-hidden="true"
                className="mb-1 min-w-4 flex-1 border-b-2 border-dotted border-slate-300"
              />
              <dd className="m-0 text-xl font-bold">
                {b.value === null && b.label === 'In predictions' && !holdings.loading ? (
                  <Button
                    type="button"
                    variant="link"
                    onClick={() => go('markets')}
                    className="h-auto min-w-0 p-0 text-sm"
                  >
                    See Markets
                  </Button>
                ) : (
                  <Money value={b.value} failed={b.failed} />
                )}
              </dd>
            </div>
          ))}
        </TotalAssetsHeader>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {actions.map(({ label, icon: Icon, onClick }) => (
            <Button
              key={label}
              type="button"
              variant="secondary"
              onClick={onClick}
              className="justify-center"
            >
              <Icon />
              {label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

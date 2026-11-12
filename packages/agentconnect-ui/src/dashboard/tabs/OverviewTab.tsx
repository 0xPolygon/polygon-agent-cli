import { ArrowDownLeft, ArrowUpRight, Bot, Plus } from 'lucide-react';

import { Button, Separator } from '@polygonlabs/design-system';

import type { Holding } from '../../indexer';
import type { Loadable } from '../types.js';

import { Money } from '../../components/Money.js';
import { sum } from '../../utils/holdings.js';

interface OverviewTabProps {
  holdings: Loadable<Holding[]>;
  positionsValue: number | null;
  // Money in the Katana earn vaults (not in `holdings`, which is Polygon only).
  vaultsValue: number | null;
  // Blended rate on what's earning, percent a year.
  earningApy: number | null;
  go: (tab: string) => void;
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
  const total = holdings.error ? 0 : sum(holdings.data);
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
      value: earning === null ? null : earning + (vaultsValue ?? 0),
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
        <div className="grid grid-cols-[minmax(0,1fr)] items-center gap-6 md:grid-cols-[auto_1px_1fr] md:gap-10">
          <div className="flex flex-col items-center gap-2 md:items-start">
            <span className="text-sm font-medium text-muted">Balance</span>
            <span className="text-6xl leading-[1.1] font-bold break-all">
              <Money value={totalWithPositions} />
            </span>
            {holdings.error && (
              <span className="text-sm text-destructive font-medium">
                Couldn't load your balance. Refresh to try again.
              </span>
            )}
          </div>
          <Separator orientation="vertical" className="hidden h-full md:block" />
          <dl className="m-0 flex flex-col gap-3">
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
          </dl>
        </div>
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

import { Button, cn } from '@polygonlabs/design-system';

import type { ActivityItem, Holding } from '../../indexer';
import type { Loadable } from '../types.js';

import { Money } from '../../components/Money.js';
import { sum } from '../../utils/holdings.js';
import { ActivityList } from './ActivityList.js';
import { FlowChart } from './FlowChart.js';
import { SECTION_TITLE } from './styles.js';

interface OverviewTabProps {
  holdings: Loadable<Holding[]>;
  activity: Loadable<ActivityItem[]>;
  positionsValue: number | null;
  // Money in the Katana earn vaults (not in `holdings`, which is Polygon only).
  vaultsValue: number | null;
  // Blended rate on what's earning, percent a year.
  earningApy: number | null;
  go: (tab: string) => void;
  onAdd: () => void;
  onWithdraw: () => void;
}

export function OverviewTab({
  holdings,
  activity,
  positionsValue,
  vaultsValue,
  earningApy,
  go,
  onAdd,
  onWithdraw
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
      color: 'bg-brand',
      tab: 'wallet'
    },
    {
      label: 'In predictions',
      value: positionsValue,
      failed: false,
      color: 'bg-purple-300',
      tab: 'markets'
    },
    {
      label: 'Earning',
      value: earning === null ? null : earning + (vaultsValue ?? 0),
      failed: holdings.error,
      color: 'bg-emerald-500',
      tab: 'earn',
      note: earningApy === null ? null : `${earningApy.toFixed(2)}% APY`
    }
  ];
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <span className="text-[15px] text-muted">Total balance</span>
          <span className="text-5xl md:text-[64px] font-bold tracking-[-0.03em] leading-none">
            <Money value={totalWithPositions} />
          </span>
          {holdings.error && (
            <span className="text-[15px] text-destructive font-medium">
              Couldn't load your balance. Refresh to try again.
            </span>
          )}
        </div>
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}
        >
          {buckets.map((b) => (
            <button
              key={b.label}
              type="button"
              onClick={() => go(b.tab)}
              className="flex flex-col gap-2.5 p-4 rounded-2xl border border-slate-200 bg-white text-left cursor-pointer hover:border-border-hover transition-colors"
            >
              <span className="flex items-center gap-2 text-sm text-muted">
                <span className={cn('w-2 h-2 rounded-full', b.color)} />
                {b.label}
              </span>
              <span className="text-[22px] font-bold">
                {b.value === null && b.tab === 'markets' && !holdings.loading ? (
                  <span className="text-slate-400">See Markets</span>
                ) : (
                  <Money value={b.value} failed={b.failed} />
                )}
              </span>
              {'note' in b && b.note && (
                <span className="text-sm font-bold text-success -mt-1">{b.note}</span>
              )}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2.5 md:max-w-[400px]">
          <Button type="button" size="lg" onClick={onAdd} className="justify-center">
            Add money
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            onClick={onWithdraw}
            className="justify-center"
          >
            Withdraw
          </Button>
        </div>
      </div>

      {activity.data && <FlowChart activity={activity.data} />}

      <div className="flex flex-col gap-3">
        <div className="flex justify-between items-center">
          <span className={SECTION_TITLE}>Recent activity</span>
          <Button type="button" variant="ghost" onClick={() => go('activity')}>
            See all
          </Button>
        </div>
        <ActivityList activity={activity} limit={4} />
      </div>
    </div>
  );
}

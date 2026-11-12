import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';

import { Card, cn, Skeleton } from '@polygonlabs/design-system';

import type { ActivityItem } from '../../indexer';
import type { Loadable } from '../types.js';

import { EmptyNotice } from '../../components/EmptyNotice.js';
import { qty, shortAddr, signedUsd, when } from '../../utils/format.js';
import { EXPLORER } from '../explorer.js';
import { ROW_LIST } from './styles.js';

interface ActivityRowProps {
  item: ActivityItem;
}

interface ActivityListProps {
  activity: Loadable<ActivityItem[]>;
  limit?: number;
}

export function ActivityRow({ item }: ActivityRowProps) {
  const incoming = item.direction === 'in';
  const Icon = incoming ? ArrowDownLeft : ArrowUpRight;
  const amount =
    item.usd > 0
      ? signedUsd(incoming ? item.usd : -item.usd)
      : `${incoming ? '+' : '-'}${qty(item.qty)} ${item.symbol}`;
  return (
    <a
      href={`${EXPLORER}/tx/${item.txnHash}`}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 py-3.5 text-primary hover:text-primary no-underline"
    >
      <span className="size-10 rounded-xl bg-background-info flex items-center justify-center flex-shrink-0">
        <Icon className="size-[18px] text-brand" />
      </span>
      <span className="flex-1 min-w-0 flex flex-col gap-1">
        <span className="text-[15px] font-bold leading-tight">
          {incoming ? 'Received' : 'Sent'} {qty(item.qty)} {item.symbol}
        </span>
        <span className="text-[13px] text-muted truncate">
          {incoming ? 'From' : 'To'} {shortAddr(item.counterparty)} · {when(item.timestamp)}
        </span>
      </span>
      <span
        className={cn(
          'text-[15px] font-bold whitespace-nowrap',
          incoming ? 'text-success' : 'text-primary'
        )}
      >
        {amount}
      </span>
    </a>
  );
}

export function ActivityList({ activity, limit }: ActivityListProps) {
  if (activity.loading) {
    return (
      <Card className={ROW_LIST}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="py-4 flex items-center gap-3">
            <Skeleton className="w-10 h-10" />
            <Skeleton className="h-4 flex-1" />
          </div>
        ))}
      </Card>
    );
  }
  const rows = (activity.data ?? []).slice(0, limit);
  return (
    <Card className={ROW_LIST}>
      {activity.error ? (
        <EmptyNotice title="Couldn't load activity">Refresh the page to try again.</EmptyNotice>
      ) : rows.length === 0 ? (
        <EmptyNotice title="Nothing yet">
          Money your agents send and receive shows up here.
        </EmptyNotice>
      ) : (
        rows.map((it, i) => <ActivityRow key={`${it.txnHash}-${i}`} item={it} />)
      )}
    </Card>
  );
}

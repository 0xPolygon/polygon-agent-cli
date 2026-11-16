import {
  Card,
  Skeleton,
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow
} from '@polygonlabs/design-system';

import type { ActivityItem } from '../../indexer';
import type { Loadable } from '../types.js';
import type { ActivityFilterValue } from './ActivityFilter.js';

import { EmptyState } from '../../components/EmptyState.js';
import { useActivityLogos } from '../../hooks/useActivityLogos.js';
import { visibleActivity } from '../../utils/visibleActivity.js';
import { activityType } from '../derive.js';
import { ActivityTableRow } from './ActivityTableRow.js';

interface ActivityListProps {
  activity: Loadable<ActivityItem[]>;
  filter: ActivityFilterValue;
}

const COLUMNS = ['Date', 'Type', 'Token and amount', 'USD', 'Counterparty', 'Direction'];

export function ActivityList({ activity, filter }: ActivityListProps) {
  const items = activity.data ?? [];
  // Type comes from every transfer, so a swap still reads as one when its other leg is filtered out.
  const visible = visibleActivity(items);
  const shown = visible.filter((i) => filter === 'all' || i.direction === filter);
  const logos = useActivityLogos(shown);
  if (activity.loading) {
    return (
      <div className="flex flex-col gap-2.5">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (activity.error) {
    return <EmptyState title="Couldn't load activity">Refresh the page to try again.</EmptyState>;
  }
  if (visible.length === 0) {
    return (
      <EmptyState title="Nothing yet">Money your agents send and receive shows up here.</EmptyState>
    );
  }
  if (shown.length === 0) {
    return (
      <EmptyState title={filter === 'in' ? 'No money in yet' : 'No money out yet'}>
        Nothing matches this filter. Try All.
      </EmptyState>
    );
  }
  return (
    <Card variant="outline" className="rounded-3xl p-3">
      <Table className="min-w-[700px] [&_td]:px-2 [&_th]:px-2">
        <TableHeader>
          <TableRow>
            {COLUMNS.map((c) => (
              <TableHead key={c}>{c}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((item, i) => (
            <ActivityTableRow
              key={`${item.txnHash}-${i}`}
              item={item}
              kind={activityType({ item, items })}
              logo={logos[item.address]}
            />
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

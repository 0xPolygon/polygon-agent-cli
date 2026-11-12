import { useState } from 'react';

import { Button } from '@polygonlabs/design-system';

import type { ActivityItem } from '../../indexer';
import type { Loadable } from '../types.js';

import { ActivityList } from './ActivityList.js';

interface ActivityTabProps {
  activity: Loadable<ActivityItem[]>;
}

export function ActivityTab({ activity }: ActivityTabProps) {
  const [filter, setFilter] = useState<'all' | 'in' | 'out'>('all');
  const data = activity.data?.filter((a) => filter === 'all' || a.direction === filter) ?? null;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex gap-2 flex-wrap">
        {(
          [
            ['all', 'All'],
            ['in', 'Money in'],
            ['out', 'Money out']
          ] as const
        ).map(([id, label]) => (
          <Button
            key={id}
            type="button"
            variant={filter === id ? 'default' : 'secondary'}
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
            className="h-9 rounded-full px-4"
          >
            {label}
          </Button>
        ))}
      </div>
      <ActivityList activity={{ ...activity, data }} />
    </div>
  );
}

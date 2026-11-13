import { useState } from 'react';

import type { ActivityItem } from '../../indexer';
import type { Loadable } from '../types.js';
import type { ActivityFilterValue } from './ActivityFilter.js';

import { SectionHeader } from '../../components/SectionHeader.js';
import { ActivityFilter } from './ActivityFilter.js';
import { ActivityList } from './ActivityList.js';

interface ActivityTabProps {
  activity: Loadable<ActivityItem[]>;
}

export function ActivityTab({ activity }: ActivityTabProps) {
  const [filter, setFilter] = useState<ActivityFilterValue>('all');
  return (
    <div className="flex flex-col gap-3">
      <SectionHeader title="Activity" />
      <ActivityFilter value={filter} onChange={setFilter} />
      <ActivityList activity={activity} filter={filter} />
    </div>
  );
}

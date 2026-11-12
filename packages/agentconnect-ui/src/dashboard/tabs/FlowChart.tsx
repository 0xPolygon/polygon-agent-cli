import { Card, cn } from '@polygonlabs/design-system';

import type { ActivityItem } from '../../indexer';

import { dailyFlow } from '../../indexer';
import { usd } from '../../utils/format.js';

interface FlowChartProps {
  activity: ActivityItem[];
}

export function FlowChart({ activity }: FlowChartProps) {
  const days = dailyFlow(activity, 14);
  const max = Math.max(1, ...days.flatMap((d) => [d.in, d.out]));
  const totalIn = days.reduce((s, d) => s + d.in, 0);
  const totalOut = days.reduce((s, d) => s + d.out, 0);
  const label = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const bar = (v: number) => (v ? Math.max(4, (v / max) * 100) : 0) + '%';
  return (
    <Card className="flex flex-col gap-5">
      <div className="flex justify-between items-start flex-wrap gap-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-lg font-bold">Money in and out</span>
          <span className="text-sm text-muted">Last 14 days</span>
        </div>
        <div className="flex gap-5 text-sm">
          {[
            ['In', totalIn, 'bg-brand'],
            ['Out', totalOut, 'bg-slate-300']
          ].map(([name, v, color]) => (
            <span key={name as string} className="flex flex-col gap-1">
              <span className="flex items-center gap-1.5 text-muted">
                <span className={cn('w-2 h-2 rounded-sm', color as string)} />
                {name}
              </span>
              <span className="font-bold text-base">{usd(v as number)}</span>
            </span>
          ))}
        </div>
      </div>
      {totalIn + totalOut === 0 && (
        <span className="text-sm text-muted -mb-2">No money moved in the last 14 days.</span>
      )}
      <div
        className="grid gap-1.5 items-end h-[140px] border-b border-slate-100"
        style={{ gridTemplateColumns: 'repeat(14, minmax(0, 1fr))' }}
        role="img"
        aria-label={`Last 14 days: ${usd(totalIn)} in, ${usd(totalOut)} out`}
      >
        {days.map((d) => (
          <div key={d.date.toISOString()} className="flex gap-0.5 items-end justify-center h-full">
            <div
              className="w-[45%] max-w-3 rounded-t-[3px] bg-brand"
              style={{ height: bar(d.in) }}
              title={`${label(d.date)}: ${usd(d.in)} in`}
            />
            <div
              className="w-[45%] max-w-3 rounded-t-[3px] bg-slate-300"
              style={{ height: bar(d.out) }}
              title={`${label(d.date)}: ${usd(d.out)} out`}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-xs text-slate-400">
        <span>{label(days[0].date)}</span>
        <span>{label(days[7].date)}</span>
        <span>Today</span>
      </div>
    </Card>
  );
}

import { Badge, cn, Progress } from '@polygonlabs/design-system';

import type { Position } from '../markets.js';

import { cents } from '../markets.js';

interface OutcomeRowProps {
  position: Position;
  highlighted: boolean;
}

export function OutcomeRow({ position, highlighted }: OutcomeRowProps) {
  const percent = Math.round(Math.min(1, Math.max(0, position.curPrice)) * 100);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 gap-y-1">
      <div className="flex min-w-0 flex-col gap-3">
        <span className="truncate text-base font-medium">{position.outcome || 'Position'}</span>
        <Progress
          value={percent}
          size="xs"
          indicatorClassName={cn(highlighted ? 'bg-purple-600' : 'bg-primary')}
          aria-label={`${position.outcome} price`}
        />
      </div>
      <span className="min-w-12 text-right text-sm font-bold whitespace-nowrap text-muted">
        {position.curPrice > 0 ? `${(1 / position.curPrice).toFixed(2)}x` : '–'}
      </span>
      <Badge variant="info" className="h-6.5 w-11 justify-center border-purple-200">
        {percent}%
      </Badge>
      <span className="col-span-3 text-xs font-medium text-muted">
        Bought at {cents(position.avgPrice)} · Now {cents(position.curPrice)}
      </span>
    </div>
  );
}

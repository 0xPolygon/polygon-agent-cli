import { Card, cn, focusRingVariants } from '@polygonlabs/design-system';

import type { MarketGroup } from '../../utils/groupPositions.js';

import { signedUsd, usd } from '../../utils/format.js';
import { OutcomeRow } from './OutcomeRow.js';

const DAY_MS = 24 * 60 * 60 * 1000;

interface MarketCardProps {
  market: MarketGroup;
}

export function MarketCard({ market }: MarketCardProps) {
  const title = <span className="text-xl font-bold leading-tight">{market.title}</span>;
  return (
    <Card variant="outline" className="flex flex-col gap-6 p-6">
      {market.slug ? (
        <a
          href={`https://polymarket.com/event/${market.slug}`}
          target="_blank"
          rel="noopener noreferrer"
          className={cn('rounded-sm text-primary hover:text-link', focusRingVariants())}
        >
          {title}
        </a>
      ) : (
        title
      )}
      <div className="flex flex-col gap-6">
        {market.positions.map((p, i) => (
          <OutcomeRow key={p.outcome} position={p} highlighted={i === 0} />
        ))}
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm font-medium text-muted">
        <span>
          <span className="text-link">{usd(market.cost)} contribution</span> · Worth{' '}
          {usd(market.value)} ({signedUsd(market.gain)})
        </span>
        {market.endDate && (
          <span>
            {new Date(market.endDate).getTime() + DAY_MS <= Date.now() ? 'Ended' : 'Ends'}{' '}
            {new Date(market.endDate).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric'
            })}
          </span>
        )}
      </div>
    </Card>
  );
}

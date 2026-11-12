import { Badge, Card, Skeleton } from '@polygonlabs/design-system';

import type { Position } from '../markets.js';
import type { Loadable } from '../types.js';

import { EmptyState } from '../../components/EmptyState.js';
import { PromptsButton } from '../../components/PromptsButton.js';
import { groupPositions, roundCents } from '../../utils/groupPositions.js';
import { MarketCard } from './MarketCard.js';
import { MarketsHeader } from './MarketsHeader.js';

interface MarketsTabProps {
  positions: Loadable<Position[]>;
  cash: Loadable<number>;
  hasAccount: boolean;
  onOpenPrompts: () => void;
}

function CardSkeleton() {
  return (
    <Card variant="outline" className="flex flex-col gap-4 p-6">
      <Skeleton className="h-6 w-3/4" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-4 w-1/2" />
    </Card>
  );
}

export function MarketsTab({ positions, cash, hasAccount, onOpenPrompts }: MarketsTabProps) {
  const rows = positions.data ?? [];
  const rawValue = rows.reduce((s, p) => s + p.value, 0);
  const value = roundCents(rawValue);
  const cost = roundCents(rows.reduce((s, p) => s + p.cost, 0));
  const loaded = positions.data !== null;
  const total = loaded ? rawValue + (cash.data ?? 0) : null;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-2xl font-bold">Your predictions</h2>
        <div className="flex items-center gap-2">
          <Badge variant="neutral" size="sm">
            Polymarket
          </Badge>
          <PromptsButton onClick={onOpenPrompts} />
        </div>
      </div>
      {!hasAccount ? (
        <EmptyState title="No predictions on this page yet">
          Ask your agent to make a prediction. Open this page from your agent's latest link to see
          your positions here.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-10">
          <MarketsHeader
            total={total}
            deposited={loaded ? cost : null}
            earned={loaded ? roundCents(value - cost) : null}
            cash={cash.data}
            failed={!!positions.error}
            cashFailed={!!cash.error}
          />
          {positions.error ? (
            <EmptyState title="Couldn't load your predictions">
              Refresh the page to try again.
            </EmptyState>
          ) : positions.loading ? (
            <div className="grid gap-5 lg:grid-cols-2">
              <CardSkeleton />
              <CardSkeleton />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState title="No open predictions">
              Ask your agent to find a market for you.
            </EmptyState>
          ) : (
            <div className="grid gap-5 lg:grid-cols-2">
              {groupPositions(rows).map((m) => (
                <MarketCard key={m.key} market={m} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import { Skeleton } from '@polygonlabs/design-system';

import type { Holding } from '../../indexer';
import type { Loadable } from '../types.js';

import { EmptyState } from '../../components/EmptyState.js';
import { useTokenLooks } from '../../hooks/useTokenLooks.js';
import { filterHoldings } from '../derive.js';
import { HoldingRow } from './HoldingRow.js';

interface HoldingsListProps {
  holdings: Loadable<Holding[]>;
  query?: string;
}

export function HoldingsList({ holdings, query = '' }: HoldingsListProps) {
  const looks = useTokenLooks(holdings.data);
  const displayNames = Object.fromEntries(Object.entries(looks).map(([a, l]) => [a, l.name]));
  const matches = filterHoldings({ holdings: holdings.data ?? [], query, displayNames });
  if (holdings.loading) {
    return (
      <div className="flex flex-col gap-2.5">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[51px] w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (holdings.error) {
    return (
      <EmptyState title="Couldn't load your balances">Refresh the page to try again.</EmptyState>
    );
  }
  if (matches.length === 0) {
    return query.trim() !== '' ? (
      <EmptyState title="No matching tokens">Try a different name or symbol.</EmptyState>
    ) : (
      <EmptyState title="Your wallet is empty">Add money to get your agents started.</EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-2.5">
      {matches.map((h, i) => (
        <HoldingRow key={`${h.address}-${i}`} holding={h} look={looks[h.address]} />
      ))}
    </div>
  );
}

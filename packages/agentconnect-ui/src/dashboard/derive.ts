import type { ActivityItem, Holding } from '../indexer';

export type ActivityKind = 'send' | 'receive' | 'swap';

interface FilterHoldingsParams {
  holdings: Holding[];
  query: string;
  /** Names the user sees, keyed by token address; matched alongside the indexer's name. */
  displayNames?: Record<string, string | undefined>;
}

interface ActivityTypeParams {
  item: ActivityItem;
  items: ActivityItem[];
}

export function filterHoldings({
  holdings,
  query,
  displayNames = {}
}: FilterHoldingsParams): Holding[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return holdings;
  return holdings.filter((h) =>
    [h.symbol, h.name, displayNames[h.address] ?? ''].some((t) => t.toLowerCase().includes(needle))
  );
}

// The indexer reports a swap as two transfers under one transaction hash.
export function activityType({ item, items }: ActivityTypeParams): ActivityKind {
  const opposite = items.some((o) => o.txnHash === item.txnHash && o.direction !== item.direction);
  if (opposite) return 'swap';
  return item.direction === 'in' ? 'receive' : 'send';
}

import type { ActivityItem, Holding } from '../indexer';
import type { TokenLook } from './tokens.js';

export type ActivityKind = 'send' | 'receive' | 'swap';

interface FilterHoldingsParams {
  holdings: Holding[];
  query: string;
  /** Names the user sees, keyed by token address; the indexer's name is searched only when none is known. */
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
    [h.symbol, displayNames[h.address] ?? h.name].some((t) => t.toLowerCase().includes(needle))
  );
}

// The indexer reports a swap as two transfers under one transaction hash.
export function activityType({ item, items }: ActivityTypeParams): ActivityKind {
  const opposite = items.some((o) => o.txnHash === item.txnHash && o.direction !== item.direction);
  if (opposite) return 'swap';
  return item.direction === 'in' ? 'receive' : 'send';
}

/** Distinct token addresses of the rows, in order, capped so a busy wallet can't fan out into dozens of lookups. */
export function logoAddresses({
  items,
  limit
}: {
  items: ActivityItem[];
  limit: number;
}): string[] {
  return [...new Set(items.map((i) => i.address).filter(Boolean))].slice(0, limit);
}

/** Only addresses the token list itself returned a logo for; a symbol can be spoofed, an address cannot. */
export function logosByAddress(looks: Record<string, TokenLook>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [address, look] of Object.entries(looks)) {
    if (look.logo) out[address] = look.logo;
  }
  return out;
}

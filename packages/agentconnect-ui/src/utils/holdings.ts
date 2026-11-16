import type { Holding } from '../indexer';

export function sum(holdings: Holding[] | null, kind?: Holding['kind']): number | null {
  if (!holdings) return null;
  return holdings.filter((h) => !kind || h.kind === kind).reduce((s, h) => s + h.usd, 0);
}

import type { ActivityItem } from '../indexer';

/** Airdropped spam arrives with no decimals and no price, so its amount is meaningless and it reads as "+0". */
export function visibleActivity(items: ActivityItem[]): ActivityItem[] {
  return items.filter((i) => i.scaleKnown || i.usd !== 0);
}

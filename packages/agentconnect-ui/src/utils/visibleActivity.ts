import type { ActivityItem } from '../indexer';

/** Inbound airdropped spam arrives with no decimals and no price, so it reads as "+0"; money leaving is never hidden. */
export function visibleActivity(items: ActivityItem[]): ActivityItem[] {
  return items.filter((i) => i.direction === 'out' || i.scaleKnown || i.usd !== 0);
}

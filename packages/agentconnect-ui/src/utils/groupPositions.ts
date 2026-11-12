import type { Position } from '../dashboard/markets.js';

export interface MarketGroup {
  key: string;
  title: string;
  slug: string;
  endDate: string | null;
  positions: Position[];
  cost: number;
  value: number;
  gain: number;
  unrealizedPnl: number;
}

export const roundCents = (n: number) => Math.round(n * 100) / 100;

interface PredictionsTotalInput {
  positions: Position[];
  cash: number | null;
}

// The header total is the sum of its displayed lines: rounded worth plus rounded cash.
export function predictionsTotal({ positions, cash }: PredictionsTotalInput): number {
  const worth = roundCents(positions.reduce((s, p) => s + p.value, 0));
  return roundCents(worth + roundCents(cash ?? 0));
}

interface MarketGainInput {
  cost: number;
  value: number;
  unrealizedPnl: number;
}

// Worth minus contribution, both rounded to cents, so each card adds up on screen.
export function marketGain({ cost, value }: MarketGainInput): number {
  return roundCents(roundCents(value) - roundCents(cost));
}

export function groupPositions(positions: Position[]): MarketGroup[] {
  const groups = new Map<string, MarketGroup>();
  for (const p of positions) {
    const key = `${p.slug}|${p.title}`;
    const group = groups.get(key) ?? {
      key,
      title: p.title,
      slug: p.slug,
      endDate: p.endDate,
      positions: [],
      cost: 0,
      value: 0,
      gain: 0,
      unrealizedPnl: 0
    };
    group.positions.push(p);
    group.cost += p.cost;
    group.value += p.value;
    group.unrealizedPnl += p.pnl;
    groups.set(key, group);
  }
  return [...groups.values()].map((g) => {
    const cost = roundCents(g.cost);
    const value = roundCents(g.value);
    return {
      ...g,
      cost,
      value,
      unrealizedPnl: roundCents(g.unrealizedPnl),
      gain: marketGain({ cost, value, unrealizedPnl: g.unrealizedPnl })
    };
  });
}

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
// unrealizedPnl is accepted but unused so switching to the provider's figure is a one-line change.
export function marketGain({ cost, value }: MarketGainInput): number {
  return roundCents(roundCents(value) - roundCents(cost));
}

// Outcomes of one market share a slug, but the title is part of the key so two
// markets that reuse a slug stay separate cards.
const groupKey = (p: Position) => `${p.slug}|${p.title}`;

// Raw, unrounded sums; rounding happens once at the end so float error doesn't compound.
interface GroupTotals {
  key: string;
  title: string;
  slug: string;
  endDate: string | null;
  positions: Position[];
  cost: number;
  value: number;
  pnl: number;
}

function sumByMarket(positions: Position[]): GroupTotals[] {
  const totals = new Map<string, GroupTotals>();
  for (const p of positions) {
    const key = groupKey(p);
    const group = totals.get(key) ?? {
      key,
      title: p.title,
      slug: p.slug,
      endDate: p.endDate,
      positions: [],
      cost: 0,
      value: 0,
      pnl: 0
    };
    group.positions.push(p);
    group.cost += p.cost;
    group.value += p.value;
    group.pnl += p.pnl;
    totals.set(key, group);
  }
  return [...totals.values()];
}

function toMarketGroup({ pnl, ...totals }: GroupTotals): MarketGroup {
  const cost = roundCents(totals.cost);
  const value = roundCents(totals.value);
  return {
    ...totals,
    cost,
    value,
    unrealizedPnl: roundCents(pnl),
    gain: marketGain({ cost, value, unrealizedPnl: pnl })
  };
}

export function groupPositions(positions: Position[]): MarketGroup[] {
  return sumByMarket(positions).map(toMarketGroup);
}

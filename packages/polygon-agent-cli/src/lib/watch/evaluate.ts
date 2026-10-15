// One watch, one price reading: which thresholds fire (FS §8.2). Pure.
//
// A threshold fires while armed and crossed, then disarms; it re-arms once the
// price moves 2% back (buy at ≥ buyBelow × 1.02, sell at ≤ sellAbove × 0.98).
// A stale reading fires nothing and reports staleness once per stale stretch.

export interface WatchState {
  buyBelow?: number;
  sellAbove?: number;
  buyArmed: boolean;
  sellArmed: boolean;
  lastPrice?: number;
  lastPriceAt?: string;
  staleNotified: boolean;
}

export type WatchEvent = 'buy_below' | 'sell_above';

export const REARM_SHARE = 0.02;

export function evaluate(params: {
  state: WatchState;
  price: number | undefined;
  priceAt: string | undefined;
  stale: boolean;
}): { events: WatchEvent[]; next: WatchState; staleAlert: boolean } {
  const { state, price } = params;
  if (params.stale || price === undefined) {
    return {
      events: [],
      next: { ...state, staleNotified: true },
      staleAlert: !state.staleNotified
    };
  }
  const next: WatchState = {
    ...state,
    lastPrice: price,
    ...(params.priceAt ? { lastPriceAt: params.priceAt } : {}),
    staleNotified: false
  };
  const events: WatchEvent[] = [];
  if (state.buyBelow !== undefined) {
    if (state.buyArmed && price <= state.buyBelow) {
      events.push('buy_below');
      next.buyArmed = false;
    } else if (!state.buyArmed && price >= state.buyBelow * (1 + REARM_SHARE)) {
      next.buyArmed = true;
    }
  }
  if (state.sellAbove !== undefined) {
    if (state.sellArmed && price >= state.sellAbove) {
      events.push('sell_above');
      next.sellArmed = false;
    } else if (!state.sellArmed && price <= state.sellAbove * (1 - REARM_SHARE)) {
      next.sellArmed = true;
    }
  }
  return { events, next, staleAlert: false };
}

// Whether a threshold is already crossed at this price (creating such a watch
// needs --confirm, since it fires at the first check).
export function alreadyPast(params: {
  buyBelow?: number;
  sellAbove?: number;
  price: number;
}): WatchEvent[] {
  const past: WatchEvent[] = [];
  if (params.buyBelow !== undefined && params.price <= params.buyBelow) past.push('buy_below');
  if (params.sellAbove !== undefined && params.price >= params.sellAbove) past.push('sell_above');
  return past;
}

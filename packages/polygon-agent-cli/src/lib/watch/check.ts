// One `watch check` (architecture §8.3), under the watch lock (a concurrent
// run is skipped: it covers the due watches):
//   0. Deliver alerts an earlier check owed (see `owe`).
//   1. Follow up auto trades still under way.
//   2. Expire old watches.
//   3. One batched price read for the due watches (none when nothing is due);
//      evaluate each and save it before acting, so a crash can't fire it twice.
//   4. Crossings raise alerts; `auto` watches quote their trade, save it as
//      pending, then execute it, and the alert says how it went.
//   5. The session checks (allowance, expiry, uncovered funds), hourly per wallet.
//   6. Record the check.

import { randomBytes } from 'node:crypto';

import type { PriceQuery, PriceReading } from '../prices.ts';
import type { TradeRecord } from '../trade/state.ts';
import type { NewAlert, StoredAlert } from './alerts.ts';
import type { Watch } from './store.ts';

import { CliError, errorJson } from '../errors.ts';
import { priceIsFresh, priceKey, STALE_PRICE_MS } from '../prices.ts';
import { describeTrade } from '../trade/quote.ts';
import { raiseAlert } from './alerts.ts';
import { evaluate } from './evaluate.ts';
import {
  LockHeldError,
  loadCheckState,
  loadWatches,
  saveCheckState,
  saveWatches,
  withWatchLock
} from './store.ts';

export const SESSION_CHECK_EVERY_MS = 60 * 60 * 1000;
// Cancelled and expired watches are dropped from watches.json after this.
const KEEP_ENDED_MS = 30 * 24 * 60 * 60 * 1000;

export interface CheckDeps {
  now: () => Date;
  prices: (tokens: PriceQuery[]) => Promise<Map<string, PriceReading>>;
  // Quote a watch's trade and save it as `quoted` (nothing is sent).
  quote: (params: {
    watch: Watch;
    side: 'buy' | 'sell';
  }) => Promise<{ trade: TradeRecord; highFee: boolean; warnings: string[] }>;
  // Execute a quoted trade, sending no deposit after notAfter (ms); returns
  // it in its latest state.
  execute: (params: { trade: TradeRecord; notAfter: number }) => Promise<TradeRecord>;
  // Follow a trade already under way (never sends anything).
  resumeTrade: (intentId: string) => Promise<TradeRecord | null>;
  loadTrade: (intentId: string) => TradeRecord | null;
  // The wallet `watch check` was run for; its allowance alerts are checked
  // along with those of every wallet with an active watch.
  walletName: string;
  sessionAlerts?: (walletName: string) => Promise<NewAlert[]>;
}

export interface CheckResult {
  ok: true;
  skipped?: true;
  checkedAt: string;
  due: number;
  alerts: StoredAlert[];
  nextCheckAt?: string;
  warnings?: string[];
}

const TERMINAL = new Set(['completed', 'failed', 'refunded']);
// Failures that say nothing about the trade itself: the level stays armed and
// the next check tries again.
// (quote_expired: a deadline passed before the deposit; nothing was sent.)
const RETRYABLE = new Set([
  'wallet_busy',
  'rate_limited',
  'upstream_unavailable',
  'quote_search_incomplete',
  'quote_expired'
]);

function usd(value: number): string {
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: value < 1 ? 6 : 2 })}`;
}

function walletFlag(watch: Watch): string {
  return watch.walletName === 'main' ? '' : ` --wallet ${watch.walletName}`;
}

// The swap a crossing suggests (alert mode) or runs (auto mode).
export function suggestedSwap(params: { watch: Watch; side: 'buy' | 'sell' }): string {
  const { watch } = params;
  if (params.side === 'buy') {
    return `polygon-agent swap --to ${watch.token}${watch.chain !== undefined ? ` --to-chain ${watch.chain}` : ''} --amount-usd ${watch.buyAmountUsd ?? '<usd>'}${walletFlag(watch)} --dry-run`;
  }
  return `polygon-agent swap --from ${watch.sellToken ?? watch.token} --chain ${watch.chain ?? 137} --to USDC --amount ${watch.sellAmount ?? '<amount>'}${walletFlag(watch)} --dry-run`;
}

function crossingMessage(params: { watch: Watch; side: 'buy' | 'sell'; price: number }): string {
  const { watch, side, price } = params;
  return side === 'buy'
    ? `${watch.price.symbol} is ${usd(price)}, at or below the ${usd(watch.buyBelow ?? 0)} buy level.`
    : `${watch.price.symbol} is ${usd(price)}, at or above the ${usd(watch.sellAbove ?? 0)} sell level.`;
}

function tradeAlert(params: {
  watch: Watch;
  side: 'buy' | 'sell';
  trade: TradeRecord;
  prefix: string;
  error?: Record<string, unknown>;
}): NewAlert {
  const { trade } = params;
  const data = {
    side: params.side,
    trade: describeTrade(trade),
    ...(params.error ? { error: params.error } : {})
  };
  if (trade.state === 'completed') {
    return {
      kind: 'auto_trade_completed',
      watchId: params.watch.id,
      message: `${params.prefix} The auto ${params.side} completed: ${trade.origin.symbol} → ${trade.destination.symbol} on ${trade.destination.chain}.`,
      data
    };
  }
  if (TERMINAL.has(trade.state) || trade.state === 'quoted') {
    return {
      kind: 'auto_trade_failed',
      watchId: params.watch.id,
      message:
        trade.state === 'quoted'
          ? `${params.prefix} The auto ${params.side} didn't run (nothing was sent): ${String(params.error?.error ?? trade.error ?? 'the quote was never executed')}.`
          : `${params.prefix} The auto ${params.side} failed${trade.state === 'refunded' ? ' and Trails refunded the deposit' : ''}: ${trade.error ?? trade.state}.`,
      command:
        typeof params.error?.command === 'string'
          ? params.error.command
          : `polygon-agent swap status --intent ${trade.intentId}`,
      data
    };
  }
  return {
    kind: 'auto_trade_executing',
    watchId: params.watch.id,
    message: params.error
      ? `${params.prefix} The auto ${params.side}'s deposit may have gone out, but the trade hit an error (${String(params.error.error)}); the next check follows it up.`
      : `${params.prefix} The auto ${params.side} is still running; the next check follows it up.`,
    command: `polygon-agent swap status --intent ${trade.intentId}`,
    data
  };
}

// An owner-mode deposit with an unclear outcome can't be settled by the CLI
// (only session transfers are recorded), so it isn't followed up: the user
// checks the wallet's activity instead.
function unfollowable(trade: TradeRecord): boolean {
  return trade.mode === 'owner' && trade.state === 'depositing' && !trade.depositTxHash;
}

function unclearAlert(params: {
  watch: Watch;
  side: 'buy' | 'sell';
  trade: TradeRecord;
}): NewAlert {
  return {
    kind: 'auto_trade_unknown',
    watchId: params.watch.id,
    message: `Watch ${params.watch.id}: it's unclear whether the auto ${params.side}'s deposit (intent ${params.trade.intentId}) went out, and the CLI can't tell for an owner-mode wallet. Check the wallet's activity before trading again.`,
    command: `polygon-agent swap status --intent ${params.trade.intentId}`,
    data: { side: params.side, trade: describeTrade(params.trade) }
  };
}

export async function runCheck(deps: CheckDeps): Promise<CheckResult> {
  try {
    return await withWatchLock({ fn: () => checkLocked(deps) });
  } catch (error) {
    if (error instanceof LockHeldError) {
      return { ok: true, skipped: true, checkedAt: deps.now().toISOString(), due: 0, alerts: [] };
    }
    throw error;
  }
}

async function checkLocked(deps: CheckDeps): Promise<CheckResult> {
  const raised: StoredAlert[] = [];
  const warnings: string[] = [];
  const raise = (alert: NewAlert) => {
    const stored = raiseAlert({ alert, now: deps.now() });
    if (stored) raised.push(stored);
  };
  const watches = loadWatches();
  const save = () => saveWatches(watches);
  // A watch's alerts go into its outbox and are saved with the change that
  // owes them, then delivered (by key, so twice is harmless). A failed write
  // leaves them in the outbox for the next check, never lost.
  const owe = ({ watch, alert }: { watch: Watch; alert: NewAlert }) => {
    watch.outbox = [
      ...(watch.outbox ?? []),
      {
        ...alert,
        watchId: alert.watchId ?? watch.id,
        key: alert.key ?? `watch:${watch.id}:${randomBytes(6).toString('hex')}`
      }
    ];
  };
  const commit = () => {
    save();
    let delivered = false;
    for (const watch of watches) {
      if (!watch.outbox?.length) continue;
      for (const alert of watch.outbox) raise(alert);
      watch.outbox = undefined;
      delivered = true;
    }
    if (delivered) save();
  };
  // 0. Alerts an earlier check owed but couldn't deliver.
  commit();

  // 1. Trades still under way. A quote never sent (a check stopped before
  // executing it) is over: the next crossing quotes afresh.
  for (const watch of watches) {
    if (!watch.pendingTrade) continue;
    const { intentId, side } = watch.pendingTrade;
    const stored = deps.loadTrade(intentId);
    if (stored && unfollowable(stored)) {
      watch.pendingTrade = undefined;
      owe({ watch, alert: unclearAlert({ watch, side, trade: stored }) });
      commit();
      continue;
    }
    const trade = await deps.resumeTrade(intentId).catch((error: unknown) => {
      warnings.push(`Couldn't follow up trade ${intentId}: ${String(errorJson(error).error)}`);
      return undefined;
    });
    if (trade === undefined) continue;
    if (trade === null) {
      watch.pendingTrade = undefined;
      owe({
        watch,
        alert: {
          kind: 'auto_trade_unknown',
          message: `Watch ${watch.id}: the record of its auto ${side} (intent ${intentId}) is gone, so it can't be followed up.`,
          command: `polygon-agent swap status --intent ${intentId}`
        }
      });
      commit();
    } else if (TERMINAL.has(trade.state) || trade.state === 'quoted') {
      watch.pendingTrade = undefined;
      owe({ watch, alert: tradeAlert({ watch, side, trade, prefix: `Watch ${watch.id}:` }) });
      commit();
    }
  }

  // 2. Expiry.
  const now = deps.now();
  const expire = (watch: Watch) => {
    watch.status = 'expired';
    owe({
      watch,
      alert: {
        kind: 'watch_expired',
        message: `The watch on ${watch.price.symbol} expired.`,
        command: 'polygon-agent watch list'
      }
    });
    commit();
  };
  for (const watch of watches) {
    if (watch.status === 'active' && Date.parse(watch.expiresAt) <= now.getTime()) expire(watch);
  }

  // 3–4. Due watches.
  const due = watches.filter(
    (watch) => watch.status === 'active' && Date.parse(watch.nextCheckAt) <= now.getTime()
  );
  let readings = new Map<string, PriceReading>();
  if (due.length > 0) {
    try {
      readings = await deps.prices(due.map((watch) => watch.price));
    } catch (error) {
      warnings.push(`Couldn't read prices: ${String(errorJson(error).error)}`);
    }
  }
  for (const watch of due) {
    // Earlier watches' trades take time: expiry and the price's age are
    // judged when this watch's turn comes, not when the check started.
    const at = deps.now();
    if (Date.parse(watch.expiresAt) <= at.getTime()) {
      expire(watch);
      continue;
    }
    let reading = readings.get(priceKey(watch.price));
    if (reading && !reading.stale && !freshAt({ reading, at })) {
      try {
        reading = (await deps.prices([watch.price])).get(priceKey(watch.price));
      } catch (error) {
        warnings.push(`Couldn't re-read prices: ${String(errorJson(error).error)}`);
        reading = undefined;
      }
    }
    const fresh = reading !== undefined && freshAt({ reading, at: deps.now() });
    const { events, next, staleAlert } = evaluate({
      state: watch,
      price: reading?.usd,
      priceAt: reading?.updatedAt,
      stale: !fresh
    });
    Object.assign(watch, next, {
      lastCheckedAt: at.toISOString(),
      nextCheckAt: new Date(at.getTime() + watch.everyMs).toISOString()
    });
    if (staleAlert) {
      owe({
        watch,
        alert: {
          kind: 'price_stale',
          message: `No current price for ${watch.price.symbol}${reading?.updatedAt ? ` (last ${reading.updatedAt})` : ''}; the watch can't trigger until there is one.`
        }
      });
    }
    const price = reading?.usd;
    for (const event of price === undefined ? [] : events) {
      const side = event === 'buy_below' ? 'buy' : 'sell';
      const message = crossingMessage({ watch, side, price: price ?? 0 });
      if (watch.mode === 'alert') {
        owe({
          watch,
          alert: {
            kind: 'watch_triggered',
            message: `${message} Suggested next step: quote the ${side}.`,
            command: suggestedSwap({ watch, side }),
            data: { side, priceUsd: price }
          }
        });
      } else if (watch.pendingTrade) {
        // Never a second trade while one may still be in flight.
        owe({
          watch,
          alert: {
            kind: 'auto_trade_skipped',
            message: `${message} The auto ${side} wasn't run: the watch's earlier auto ${watch.pendingTrade.side} (intent ${watch.pendingTrade.intentId}) isn't settled yet.`,
            command: `polygon-agent swap status --intent ${watch.pendingTrade.intentId}`,
            data: { side, priceUsd: price }
          }
        });
      }
    }
    // Saved, with the alerts it owes, before any trade: a crash mid-trade
    // can't fire the same arming again.
    commit();
    if (watch.mode !== 'auto' || watch.pendingTrade || price === undefined) continue;
    for (const event of events) {
      const side = event === 'buy_below' ? 'buy' : 'sell';
      // No deposit once the watch has expired or its price is too old.
      const priceAt = Date.parse(reading?.updatedAt ?? at.toISOString());
      const notAfter = Math.min(Date.parse(watch.expiresAt), priceAt + STALE_PRICE_MS);
      await autoTrade({
        deps,
        watch,
        side,
        price,
        notAfter,
        message: crossingMessage({ watch, side, price }),
        owe,
        commit,
        warnings
      });
    }
  }

  // 5. Session checks, hourly per wallet.
  const state = loadCheckState();
  if (deps.sessionAlerts) {
    const wallets = new Set([
      deps.walletName,
      ...watches.filter((watch) => watch.status === 'active').map((watch) => watch.walletName)
    ]);
    const lastByWallet = { ...state.lastSessionCheckAt };
    for (const walletName of wallets) {
      const last = lastByWallet[walletName] ? Date.parse(lastByWallet[walletName]) : 0;
      if (now.getTime() - last < SESSION_CHECK_EVERY_MS) continue;
      try {
        for (const alert of await deps.sessionAlerts(walletName)) raise(alert);
        lastByWallet[walletName] = now.toISOString();
      } catch (error) {
        warnings.push(
          `Couldn't run the allowance checks for ${walletName}: ${String(errorJson(error).error)}`
        );
      }
    }
    state.lastSessionCheckAt = lastByWallet;
  }

  // 6. Record the check; drop watches that ended long ago (and owe nothing).
  const end = deps.now();
  const kept = watches.filter(
    (watch) =>
      watch.status === 'active' ||
      watch.pendingTrade ||
      watch.outbox?.length ||
      end.getTime() - Date.parse(watch.lastCheckedAt ?? watch.expiresAt) < KEEP_ENDED_MS
  );
  if (kept.length !== watches.length) saveWatches(kept);
  state.lastCheckAt = now.toISOString();
  saveCheckState(state);
  const upcoming = kept
    .filter((watch) => watch.status === 'active')
    .map((watch) => watch.nextCheckAt)
    .sort()[0];
  return {
    ok: true,
    checkedAt: now.toISOString(),
    due: due.length,
    alerts: raised,
    ...(upcoming ? { nextCheckAt: upcoming } : {}),
    ...(warnings.length ? { warnings } : {})
  };
}

function freshAt(params: { reading: PriceReading; at: Date }): boolean {
  const { reading } = params;
  if (reading.stale || reading.usd === undefined || !reading.updatedAt) return false;
  return priceIsFresh({ updatedAtMs: Date.parse(reading.updatedAt), now: params.at.getTime() });
}

// An auto watch's trade. The quote is saved as the watch's pending trade
// before anything is sent, so whatever happens next (an error after the
// deposit, a killed process), the next check follows it up.
async function autoTrade(params: {
  deps: CheckDeps;
  watch: Watch;
  side: 'buy' | 'sell';
  price: number;
  // No deposit after this: the watch's expiry, or its price going stale.
  notAfter: number;
  message: string;
  owe: (params: { watch: Watch; alert: NewAlert }) => void;
  commit: () => void;
  warnings: string[];
}): Promise<void> {
  const { deps, watch, side, price, message, owe, commit } = params;
  // Nothing sent: the level stays armed and the next check tries again.
  const retry = (reason: string) => {
    if (side === 'buy') watch.buyArmed = true;
    else watch.sellArmed = true;
    commit();
    params.warnings.push(
      `Watch ${watch.id}: the auto ${side} wasn't sent (${reason}); retrying at the next check.`
    );
  };
  if (deps.now().getTime() > params.notAfter) {
    retry(
      deps.now().getTime() >= Date.parse(watch.expiresAt)
        ? 'the watch has expired'
        : 'its price is no longer current'
    );
    return;
  }
  let quoted: Awaited<ReturnType<CheckDeps['quote']>>;
  try {
    quoted = await deps.quote({ watch, side });
  } catch (error) {
    const failure = errorJson(error);
    if (error instanceof CliError && RETRYABLE.has(error.code)) {
      retry(String(failure.error));
      return;
    }
    owe({
      watch,
      alert: {
        kind: 'auto_trade_failed',
        message: `${message} The auto ${side} didn't run: ${String(failure.error)}`,
        ...(typeof failure.command === 'string' ? { command: failure.command } : {}),
        data: { side, priceUsd: price, error: failure }
      }
    });
    commit();
    return;
  }

  const { trade } = quoted;
  if (quoted.highFee) {
    // Nobody sees an automatic quote, so a costly one isn't executed.
    owe({
      watch,
      alert: {
        kind: 'auto_trade_failed',
        message: `${message} The auto ${side} wasn't executed: ${quoted.warnings.join(' ')} Quote it again to trade anyway.`,
        command: suggestedSwap({ watch, side }),
        data: { side, priceUsd: price, trade: describeTrade(trade), warnings: quoted.warnings }
      }
    });
    commit();
    return;
  }

  watch.pendingTrade = { intentId: trade.intentId, side };
  commit();
  let latest: TradeRecord;
  let failure: Record<string, unknown> | undefined;
  try {
    latest = await deps.execute({ trade, notAfter: params.notAfter });
  } catch (error) {
    failure = errorJson(error);
    // The saved trade says whether the deposit can have gone out: `quoted`
    // (or `failed`) means certainly not.
    latest = deps.loadTrade(trade.intentId) ?? trade;
  }
  if (unfollowable(latest)) {
    watch.pendingTrade = undefined;
    owe({ watch, alert: unclearAlert({ watch, side, trade: latest }) });
    commit();
    return;
  }
  const settled = TERMINAL.has(latest.state) || latest.state === 'quoted';
  if (settled) watch.pendingTrade = undefined;
  if (
    latest.state === 'quoted' &&
    typeof failure?.code === 'string' &&
    RETRYABLE.has(failure.code)
  ) {
    // Refused before anything was sent (another command held the wallet, or
    // the deadline passed): try again at the next check.
    retry(String(failure.error));
    return;
  }
  const alert = tradeAlert({ watch, side, trade: latest, prefix: message, error: failure });
  owe({
    watch,
    alert: {
      ...alert,
      ...(quoted.warnings.length
        ? {
            data: {
              side,
              trade: describeTrade(latest),
              warnings: quoted.warnings,
              ...(failure ? { error: failure } : {})
            }
          }
        : {})
    }
  });
  commit();
}

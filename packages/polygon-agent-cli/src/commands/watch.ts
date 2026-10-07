// `watch create|list|cancel|check|run` and `alerts` (FS §8.2–8.4).
//
// Watches are checked by `watch check`, which the assistant schedules on its
// platform at the shortest active interval, or by `watch run` in the
// foreground. Nothing runs between checks.

import type { CommandModule, Argv } from 'yargs';

import { randomBytes } from 'node:crypto';

import { isAddress } from 'viem';
import { z } from 'zod';

import type { QuotedSwap } from '../lib/trade/quote.ts';
import type { NewAlert } from '../lib/watch/alerts.ts';
import type { CheckDeps, CheckResult } from '../lib/watch/check.ts';
import type { Watch } from '../lib/watch/store.ts';

import { CliError, errorJson, jsonFail, jsonOut } from '../lib/errors.ts';
import { chainIdFor, resolvePriceTarget } from '../lib/price-target.ts';
import { getPriceReadings, priceKey } from '../lib/prices.ts';
import { chainLabel, findSupportedToken, resolveSupportedSymbol } from '../lib/session/tokens.ts';
import { loadOmsWalletPointer } from '../lib/storage.ts';
import { executeSwap } from '../lib/trade/execute.ts';
import { assertTradeCovered, isNativeSymbol, quoteSwap } from '../lib/trade/quote.ts';
import { loadTrade } from '../lib/trade/state.ts';
import {
  acknowledgeAlerts,
  raiseAlert,
  readAlerts,
  unacknowledgedAlerts
} from '../lib/watch/alerts.ts';
import { runCheck } from '../lib/watch/check.ts';
import { alreadyPast } from '../lib/watch/evaluate.ts';
import { formatDuration, scheduleAdvice } from '../lib/watch/status.ts';
import {
  MAX_ACTIVE_WATCHES,
  MAX_EXPIRY_MS,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  loadCheckState,
  loadWatches,
  parseDuration,
  saveWatches,
  withWatchLock
} from '../lib/watch/store.ts';
import { sessionReport } from './wallet-session.ts';

// An auto trade waits this long for Trails before the check moves on (the
// next check follows it up).
const AUTO_TRADE_TIMEOUT_MS = 60_000;
const RESUME_TIMEOUT_MS = 10_000;
// A create or cancel waits this long for a running check (it may be trading).
const LOCK_WAIT_MS = 150_000;

function describeWatch(watch: Watch): Record<string, unknown> {
  return {
    id: watch.id,
    status: watch.status,
    mode: watch.mode,
    token: watch.price.symbol,
    ...(watch.chain !== undefined ? { chain: chainLabel(watch.chain) } : {}),
    walletName: watch.walletName,
    ...(watch.buyBelow !== undefined
      ? {
          buyBelow: watch.buyBelow,
          buyArmed: watch.buyArmed,
          ...(watch.buyAmountUsd !== undefined ? { buyAmountUsd: watch.buyAmountUsd } : {})
        }
      : {}),
    ...(watch.sellAbove !== undefined
      ? {
          sellAbove: watch.sellAbove,
          sellArmed: watch.sellArmed,
          ...(watch.sellAmount !== undefined ? { sellAmount: watch.sellAmount } : {}),
          ...(watch.sellToken !== undefined ? { sells: watch.sellToken } : {})
        }
      : {}),
    every: formatDuration(watch.everyMs),
    expiresAt: watch.expiresAt,
    nextCheckAt: watch.nextCheckAt,
    ...(watch.lastPrice !== undefined
      ? { lastPriceUsd: watch.lastPrice, lastPriceAt: watch.lastPriceAt }
      : {}),
    ...(watch.pendingTrade ? { pendingTrade: watch.pendingTrade.intentId } : {})
  };
}

// The parts of `wallet status` the hourly allowance checks use.
const SessionReportAlerts = z.object({
  allowance: z.object({ approvedAt: z.string() }).nullish(),
  alerts: z
    .array(
      z.object({
        type: z.string(),
        message: z.string(),
        command: z.string().optional(),
        key: z.string().optional()
      })
    )
    .optional()
});

// A watch's swap, as `swap` would quote it: a buy spends --buy-amount USD of a
// covered stablecoin (on the watch's chain first, to avoid a bridge); a sell
// sells --sell-amount of the token on its chain (Polygon by default) for USDC.
export async function quoteWatchTrade(params: {
  watch: Watch;
  side: 'buy' | 'sell';
  now: Date;
}): Promise<QuotedSwap> {
  const { watch, now } = params;
  if (params.side === 'sell') {
    return quoteSwap({
      walletName: watch.walletName,
      from: watch.sellToken ?? watch.token,
      to: 'USDC',
      amount: watch.sellAmount,
      chain: String(watch.chain ?? 137),
      now
    });
  }
  const buy = { walletName: watch.walletName, to: watch.token, amountUsd: watch.buyAmountUsd, now };
  if (watch.chain === undefined) return quoteSwap(buy);
  const chain = String(watch.chain);
  try {
    return await quoteSwap({ ...buy, chain, toChain: chain });
  } catch (error) {
    if (
      !(error instanceof CliError) ||
      (error.code !== 'insufficient_balance' && error.code !== 'not_covered')
    ) {
      throw error;
    }
    return quoteSwap({ ...buy, toChain: chain });
  }
}

export function liveDeps(walletName: string): CheckDeps {
  return {
    now: () => new Date(),
    prices: (tokens) => getPriceReadings({ tokens, now: new Date() }),
    quote: ({ watch, side }) => quoteWatchTrade({ watch, side, now: new Date() }),
    execute: ({ trade, notAfter }) =>
      executeSwap({ trade, timeoutMs: AUTO_TRADE_TIMEOUT_MS, notAfter }),
    resumeTrade: async (intentId) => {
      const trade = loadTrade(intentId);
      return trade ? executeSwap({ trade, timeoutMs: RESUME_TIMEOUT_MS, send: false }) : null;
    },
    loadTrade,
    walletName,
    sessionAlerts: async (wallet) => {
      const pointer = await loadOmsWalletPointer(wallet);
      if (pointer?.access !== 'session') return [];
      const report = SessionReportAlerts.safeParse(
        await sessionReport({ wallet, withVersion: false })
      );
      if (!report.success) return [];
      const approvedAt = report.data.allowance?.approvedAt ?? '';
      return (report.data.alerts ?? []).map((alert) => ({
        kind: alert.type,
        message: alert.message,
        ...(alert.command ? { command: alert.command } : {}),
        // Raised once per approval (a renewal or new allowance alerts again).
        key: `session:${wallet}:${approvedAt}:${alert.key ?? alert.type}`
      }));
    }
  };
}

// A plain amount above 0, a share in (0%, 100%], or all.
function validSellAmount(value: string): boolean {
  if (/^all$/i.test(value)) return true;
  const match = /^(\d+(?:\.\d+)?)(%?)$/.exec(value);
  if (!match) return false;
  const n = Number(match[1]);
  // A share is counted in basis points, so under 0.01% would sell nothing.
  return match[2] === '%' ? n >= 0.01 && n <= 100 : n > 0;
}

function positive(params: { value: number | undefined; flag: string }): number | undefined {
  if (params.value === undefined) return undefined;
  if (!Number.isFinite(params.value) || params.value <= 0) {
    throw new CliError({
      code: 'invalid_input',
      message: `${params.flag} must be a positive number.`
    });
  }
  return params.value;
}

interface CreateArgs {
  wallet: string;
  token?: string;
  chain?: string;
  mode?: string;
  'buy-below'?: number;
  'buy-amount'?: number;
  'sell-above'?: number;
  'sell-amount'?: string;
  every?: string;
  expires?: string;
  confirm?: boolean;
}

const createCommand: CommandModule<object, CreateArgs> = {
  command: 'create',
  describe: 'Watch a token price: alert, or trade automatically, when it crosses a level',
  builder: (y) =>
    y
      .option('wallet', { type: 'string', default: 'main', describe: 'Wallet name' })
      .option('token', { type: 'string', demandOption: true, describe: 'Token to watch' })
      .option('chain', {
        type: 'string',
        describe: 'Chain (needed for anything but ETH, BTC, POL and stablecoins)'
      })
      .option('mode', {
        type: 'string',
        choices: ['alert', 'auto'],
        demandOption: true,
        describe: 'alert: tell the user; auto: trade'
      })
      .option('buy-below', {
        type: 'number',
        describe: 'Buy (or alert) at or below this USD price'
      })
      .option('buy-amount', {
        type: 'number',
        describe: 'USD of a stablecoin to spend on the buy (auto)'
      })
      .option('sell-above', {
        type: 'number',
        describe: 'Sell (or alert) at or above this USD price'
      })
      .option('sell-amount', {
        type: 'string',
        describe: 'Amount to sell: a number, <n>%, or all (auto)'
      })
      .option('every', { type: 'string', default: '15m', describe: 'Check interval, 5m to 24h' })
      .option('expires', { type: 'string', default: '30d', describe: 'Expiry, up to 90d' })
      .option('confirm', {
        type: 'boolean',
        default: false,
        describe: 'Create it even if a level is already crossed (it fires at the next check)'
      }),
  handler: async (argv) => {
    try {
      const now = new Date();
      const mode = argv.mode === 'auto' ? 'auto' : 'alert';
      const buyBelow = positive({ value: argv['buy-below'], flag: '--buy-below' });
      const sellAbove = positive({ value: argv['sell-above'], flag: '--sell-above' });
      const buyAmountUsd = positive({ value: argv['buy-amount'], flag: '--buy-amount' });
      const sellAmount = argv['sell-amount']?.trim();
      if (buyBelow === undefined && sellAbove === undefined) {
        throw new CliError({
          code: 'invalid_input',
          message: 'Give --buy-below, --sell-above, or both.'
        });
      }
      if (buyBelow !== undefined && sellAbove !== undefined && buyBelow >= sellAbove) {
        throw new CliError({
          code: 'invalid_input',
          message: '--buy-below must be under --sell-above.'
        });
      }
      if (sellAmount !== undefined && !validSellAmount(sellAmount)) {
        throw new CliError({
          code: 'invalid_input',
          message: '--sell-amount takes a positive number, a share from 0% up to 100%, or all.'
        });
      }
      if (mode === 'auto') {
        if (buyBelow !== undefined && buyAmountUsd === undefined) {
          throw new CliError({
            code: 'invalid_input',
            message: 'An auto buy needs --buy-amount (USD to spend).'
          });
        }
        if (sellAbove !== undefined && sellAmount === undefined) {
          throw new CliError({
            code: 'invalid_input',
            message: 'An auto sell needs --sell-amount.'
          });
        }
      }
      const everyMs = parseDuration({ value: argv.every ?? '15m', flag: '--every' });
      // Whole minutes, so the advised schedule is exactly the interval.
      if (everyMs < MIN_INTERVAL_MS || everyMs > MAX_INTERVAL_MS || everyMs % 60_000 !== 0) {
        throw new CliError({
          code: 'invalid_input',
          message:
            '--every must be whole minutes between 5m and 24h (shorter checks would hammer prices and wake the assistant too often).'
        });
      }
      const expiresMs = parseDuration({ value: argv.expires ?? '30d', flag: '--expires' });
      if (expiresMs <= 0 || expiresMs > MAX_EXPIRY_MS) {
        throw new CliError({ code: 'invalid_input', message: '--expires must be at most 90d.' });
      }
      const named = argv.token ?? '';
      const chainId = argv.chain !== undefined ? chainIdFor(argv.chain) : undefined;
      const target = await resolvePriceTarget({ token: named, chain: argv.chain });
      // Trades name tokens by symbol: a reviewed token given by its address
      // trades as its symbol.
      const token =
        isAddress(named) &&
        chainId !== undefined &&
        findSupportedToken({ chainId, address: named }) !== undefined
          ? target.symbol
          : named;

      // An auto watch must be able to trade: the wallet is connected and, in
      // session mode, the token is covered. An alert watch on an uncovered
      // token works, with an alert suggesting the change.
      const pointer = await loadOmsWalletPointer(argv.wallet);
      if (mode === 'auto' && !pointer) {
        throw new CliError({
          code: 'not_connected',
          message: `Wallet '${argv.wallet}' isn't connected, so it can't trade.`,
          command: 'polygon-agent wallet login --email <email>'
        });
      }
      // Raised once the watch is saved.
      const notices: NewAlert[] = [];
      // The native coin can only be sold by amount (owner mode; a session
      // can't sell it at all).
      if (
        mode === 'auto' &&
        pointer?.access !== 'session' &&
        sellAmount !== undefined &&
        /%$|^all$/i.test(sellAmount) &&
        isNativeSymbol({ chainId: chainId ?? 137, symbol: token })
      ) {
        throw new CliError({
          code: 'invalid_input',
          message: `${token.toUpperCase()} is the native coin there, which sells by amount only: give --sell-amount as a number, not a share.`
        });
      }
      // In session mode a sell trades the covered token of the asset (ETH →
      // WETH): native coins can't be spent by the session.
      const sellToken =
        pointer?.access === 'session' && sellAbove !== undefined
          ? resolveSupportedSymbol({ chainId: chainId ?? 137, symbol: token })?.symbol
          : undefined;
      if (pointer?.access === 'session') {
        const sides = [
          ...(buyBelow !== undefined ? (['buy'] as const) : []),
          ...(sellAbove !== undefined ? (['sell'] as const) : [])
        ];
        for (const side of sides) {
          try {
            assertTradeCovered({
              walletName: argv.wallet,
              side,
              symbol: side === 'sell' ? (sellToken ?? token) : token,
              chainId
            });
          } catch (error) {
            // An alert watch spends nothing: what the session can't trade
            // only limits what it suggests.
            if (
              mode === 'auto' ||
              !(error instanceof CliError) ||
              (error.code !== 'not_covered' && error.code !== 'native_not_supported')
            ) {
              throw error;
            }
            notices.push({
              kind: error.code,
              message: `${error.message} The watch only alerts; ${error.code === 'native_not_supported' ? "this install can't make that trade" : 'to trade it, cover it first'}.`,
              ...(error.command ? { command: error.command } : {}),
              key: `${error.code}:${argv.wallet}:${token.toUpperCase()}@${chainId ?? 'any'}:${side}`
            });
          }
        }
      }

      const reading = (await getPriceReadings({ tokens: [target], now })).get(priceKey(target));
      if (reading?.usd === undefined || reading.stale) {
        throw new CliError({
          code: 'upstream_unavailable',
          message: `No current price for ${target.symbol}, so the levels can't be checked. Try again shortly.`
        });
      }
      const past = alreadyPast({ buyBelow, sellAbove, price: reading.usd });
      if (past.length > 0 && !argv.confirm) {
        throw new CliError({
          code: 'watch_already_past',
          message: `${target.symbol} is $${reading.usd}, already ${past.map((e) => (e === 'buy_below' ? `at or below $${buyBelow}` : `at or above $${sellAbove}`)).join(' and ')}. ${mode === 'auto' ? 'It would trade' : 'It would alert'} at the next check.`,
          hint: 'Ask the user; if they want that, rerun with --confirm.',
          details: { priceUsd: reading.usd }
        });
      }

      const watch: Watch = {
        id: `w_${randomBytes(4).toString('hex')}`,
        walletName: argv.wallet,
        token,
        ...(chainId !== undefined ? { chain: chainId } : {}),
        price: { chainId: target.chainId, address: target.address, symbol: target.symbol },
        mode,
        ...(buyBelow !== undefined ? { buyBelow } : {}),
        ...(buyAmountUsd !== undefined ? { buyAmountUsd } : {}),
        ...(sellAbove !== undefined ? { sellAbove } : {}),
        ...(sellAmount !== undefined ? { sellAmount } : {}),
        ...(sellToken !== undefined && sellToken !== token ? { sellToken } : {}),
        everyMs,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + expiresMs).toISOString(),
        // Due at once: the first check sets the baseline (and fires a
        // confirmed, already-crossed level).
        nextCheckAt: now.toISOString(),
        status: 'active',
        buyArmed: true,
        sellArmed: true,
        lastPrice: reading.usd,
        ...(reading.updatedAt ? { lastPriceAt: reading.updatedAt } : {}),
        staleNotified: false
      };
      const watches = await withWatchLock({
        waitMs: LOCK_WAIT_MS,
        fn: () => {
          const all = loadWatches();
          if (all.filter((w) => w.status === 'active').length >= MAX_ACTIVE_WATCHES) {
            throw new CliError({
              code: 'watch_limit_reached',
              message: `There are already ${MAX_ACTIVE_WATCHES} active watches.`,
              command: 'polygon-agent watch cancel <id>'
            });
          }
          all.push(watch);
          saveWatches(all);
          return all;
        }
      });
      const raised = notices.flatMap((notice) => {
        const stored = raiseAlert({ alert: { ...notice, watchId: watch.id }, now });
        return stored ? [stored] : [];
      });
      jsonOut({
        ok: true,
        watch: describeWatch(watch),
        priceUsd: reading.usd,
        ...(raised.length ? { alerts: raised } : {}),
        schedule: scheduleAdvice(watches),
        hint: 'Watches only run when checked: keep a recurring task running the schedule command at that interval (or run `polygon-agent watch run` in the foreground).'
      });
    } catch (error) {
      jsonFail(error);
    }
  }
};

const listCommand: CommandModule<object, { all?: boolean }> = {
  command: 'list',
  describe: 'List watches',
  builder: (y) =>
    y.option('all', {
      type: 'boolean',
      default: false,
      describe: 'Include cancelled and expired ones'
    }),
  handler: (argv) => {
    try {
      const watches = loadWatches();
      const shown = argv.all ? watches : watches.filter((watch) => watch.status === 'active');
      jsonOut({
        ok: true,
        watches: shown.map(describeWatch),
        lastCheckAt: loadCheckState().lastCheckAt ?? null,
        ...(scheduleAdvice(watches) ? { schedule: scheduleAdvice(watches) } : {})
      });
    } catch (error) {
      jsonFail(error);
    }
  }
};

const cancelCommand: CommandModule<object, { id?: string }> = {
  command: 'cancel <id>',
  describe: 'Cancel a watch',
  builder: (y) => y.positional('id', { type: 'string', describe: 'Watch id' }),
  handler: async (argv) => {
    try {
      const cancelled = await withWatchLock({
        waitMs: LOCK_WAIT_MS,
        fn: () => {
          const watches = loadWatches();
          const watch = watches.find((w) => w.id === argv.id);
          if (!watch) {
            throw new CliError({
              code: 'invalid_input',
              message: `No watch ${argv.id ?? ''}.`,
              command: 'polygon-agent watch list'
            });
          }
          if (watch.status !== 'active') {
            throw new CliError({
              code: 'invalid_input',
              message: `Watch ${watch.id} has already ${watch.status === 'expired' ? 'expired' : 'been cancelled'}.`
            });
          }
          watch.status = 'cancelled';
          saveWatches(watches);
          return { watch, remaining: watches };
        }
      });
      jsonOut({
        ok: true,
        watch: describeWatch(cancelled.watch),
        ...(cancelled.watch.pendingTrade
          ? {
              note: `Its auto ${cancelled.watch.pendingTrade.side} (intent ${cancelled.watch.pendingTrade.intentId}) is still settling; keep the recurring check until it reports.`
            }
          : cancelled.watch.outbox?.length
            ? {
                note: 'It has alerts the next check still has to deliver; keep the recurring check until then.'
              }
            : {}),
        ...(scheduleAdvice(cancelled.remaining)
          ? { schedule: scheduleAdvice(cancelled.remaining) }
          : {
              hint: 'No watches left to check, and no trades or alerts owed; the recurring watch check can be removed.'
            })
      });
    } catch (error) {
      jsonFail(error);
    }
  }
};

const checkCommand: CommandModule<object, { wallet: string }> = {
  command: 'check',
  describe: 'Check due watches once, run auto trades, print new alerts (schedule this)',
  builder: (y) =>
    y.option('wallet', {
      type: 'string',
      default: 'main',
      describe: 'Wallet whose allowance alerts to check'
    }),
  handler: async (argv) => {
    try {
      jsonOut({ ...(await runCheck(liveDeps(argv.wallet))) });
    } catch (error) {
      jsonFail(error);
    }
  }
};

// Seconds until the next check: the earliest due watch, within 30 s – 5 min
// (the hourly allowance checks ride on these runs too).
function nextDelayMs(result: CheckResult): number {
  if (result.skipped) return 60_000;
  const next = result.nextCheckAt ? Date.parse(result.nextCheckAt) - Date.now() : Infinity;
  return Math.min(5 * 60_000, Math.max(30_000, next));
}

const runCommand: CommandModule<object, { wallet: string }> = {
  command: 'run',
  describe: 'Check watches in the foreground until stopped (one JSON line per check with news)',
  builder: (y) =>
    y.option('wallet', {
      type: 'string',
      default: 'main',
      describe: 'Wallet whose allowance alerts to check'
    }),
  handler: async (argv) => {
    let stopping = false;
    let wake: (() => void) | undefined;
    const stop = () => {
      if (!stopping) {
        console.log(
          JSON.stringify({ ok: true, stopping: true, note: 'Finishing the current check.' })
        );
      }
      stopping = true;
      wake?.();
    };
    // Every signal is caught, so a second Ctrl-C can't kill a trade mid-way:
    // the current check finishes first.
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    console.log(JSON.stringify({ ok: true, running: true, startedAt: new Date().toISOString() }));
    const deps = liveDeps(argv.wallet);
    while (!stopping) {
      let delay = 60_000;
      try {
        const result = await runCheck(deps);
        if (result.alerts.length > 0 || result.warnings) console.log(JSON.stringify(result));
        delay = nextDelayMs(result);
      } catch (error) {
        console.log(JSON.stringify(errorJson(error)));
      }
      if (stopping) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    console.log(JSON.stringify({ ok: true, stopped: true, at: new Date().toISOString() }));
  }
};

export const watchCommand: CommandModule = {
  command: 'watch',
  describe: 'Price watches: alerts or automatic trades at price levels',
  builder: (y: Argv) =>
    y
      .command(createCommand)
      .command(listCommand)
      .command(cancelCommand)
      .command(checkCommand)
      .command(runCommand)
      .demandCommand(1, ''),
  handler: () => {}
};

interface AlertsArgs {
  ack?: string[];
  all?: boolean;
}

export const alertsCommand: CommandModule<object, AlertsArgs> = {
  command: 'alerts',
  describe: 'Alerts from watches and the CLI; --ack [id…] acknowledges them',
  builder: (y) =>
    y
      .option('ack', {
        type: 'string',
        array: true,
        describe: 'Acknowledge these alerts (all, without ids)'
      })
      .option('all', { type: 'boolean', default: false, describe: 'Include acknowledged alerts' }),
  handler: (argv) => {
    try {
      if (argv.ack !== undefined) {
        const acknowledged = acknowledgeAlerts({ ids: argv.ack, now: new Date() });
        jsonOut({ ok: true, acknowledged });
        return;
      }
      jsonOut({
        ok: true,
        alerts: argv.all ? readAlerts() : unacknowledgedAlerts()
      });
    } catch (error) {
      jsonFail(error);
    }
  }
};

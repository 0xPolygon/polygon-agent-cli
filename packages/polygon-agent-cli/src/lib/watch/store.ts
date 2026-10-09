// Watches (watches.json) and when they were last checked (watch-state.json),
// in the state folder. Every change happens under the watch lock, so a check
// and a create or cancel can't overwrite each other.

import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { CliError } from '../errors.ts';
import { LockHeldError, withLock } from '../lock.ts';
import { readJsonFile, writeJsonFile } from '../session/state.ts';
import { ensureStorageDir, STORAGE_ROOT } from '../storage.ts';

export const MIN_INTERVAL_MS = 5 * 60 * 1000;
export const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
export const DEFAULT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_ACTIVE_WATCHES = 20;

const WatchSchema = z.object({
  id: z.string(),
  walletName: z.string(),
  // The token as the user named it, and where it's priced.
  token: z.string(),
  chain: z.number().optional(),
  price: z.object({ chainId: z.number(), address: z.string(), symbol: z.string() }),
  mode: z.enum(['alert', 'auto']),
  buyBelow: z.number().optional(),
  // USD of a stablecoin to spend on the buy.
  buyAmountUsd: z.number().optional(),
  sellAbove: z.number().optional(),
  // Token units, <n>% or all, as for swap --amount.
  sellAmount: z.string().optional(),
  // The token a sell trades, when not the one named: in session mode, the
  // covered token of the watched asset (an ETH watch sells WETH).
  sellToken: z.string().optional(),
  everyMs: z.number(),
  createdAt: z.string(),
  expiresAt: z.string(),
  nextCheckAt: z.string(),
  status: z.enum(['active', 'cancelled', 'expired']),
  buyArmed: z.boolean(),
  sellArmed: z.boolean(),
  lastPrice: z.number().optional(),
  lastPriceAt: z.string().optional(),
  lastCheckedAt: z.string().optional(),
  staleNotified: z.boolean(),
  // An auto trade Trails was still working on at the end of a check.
  pendingTrade: z.object({ intentId: z.string(), side: z.enum(['buy', 'sell']) }).optional(),
  // Alerts owed for a change already saved (a consumed crossing, a settled
  // trade): saved with that change and delivered after, so a failed write
  // can't lose them. Each carries a unique key, so delivery is idempotent.
  outbox: z
    .array(
      z.object({
        kind: z.string(),
        watchId: z.string().optional(),
        message: z.string(),
        command: z.string().optional(),
        data: z.record(z.string(), z.unknown()).optional(),
        key: z.string()
      })
    )
    .optional()
});
export type Watch = z.infer<typeof WatchSchema>;

const WatchesFile = z.object({ watches: z.array(WatchSchema) });

const CheckStateSchema = z.object({
  lastCheckAt: z.string().optional(),
  // Per wallet: the allowance checks run at most hourly.
  lastSessionCheckAt: z.record(z.string(), z.string()).optional()
});
export type CheckState = z.infer<typeof CheckStateSchema>;

function watchesFile(): string {
  return path.join(STORAGE_ROOT, 'watches.json');
}

function stateFile(): string {
  return path.join(STORAGE_ROOT, 'watch-state.json');
}

export function loadWatches(): Watch[] {
  if (!fs.existsSync(watchesFile())) return [];
  // An unreadable file is an error, never an empty list that a save would
  // then overwrite.
  const parsed = WatchesFile.safeParse(readJsonFile(watchesFile()));
  if (!parsed.success) {
    throw new CliError({
      code: 'invalid_input',
      message: `watches.json is unreadable (${parsed.error.issues[0]?.message ?? 'bad format'}); fix or remove it.`
    });
  }
  return parsed.data.watches;
}

export function saveWatches(watches: Watch[]): void {
  ensureStorageDir();
  writeJsonFile({ file: watchesFile(), data: { watches } });
}

export function loadCheckState(): CheckState {
  const parsed = CheckStateSchema.safeParse(readJsonFile(stateFile()) ?? {});
  return parsed.success ? parsed.data : {};
}

export function saveCheckState(state: CheckState): void {
  ensureStorageDir();
  writeJsonFile({ file: stateFile(), data: state });
}

function lockDir(): string {
  return path.join(STORAGE_ROOT, 'locks', 'watch.lock');
}

// Runs fn under the watch lock. A check that finds it held is skipped (the
// other run covers the due watches); a create or cancel waits for it.
export async function withWatchLock<T>(params: {
  fn: () => Promise<T> | T;
  waitMs?: number;
}): Promise<T> {
  try {
    return await withLock({ dir: lockDir(), fn: params.fn, waitMs: params.waitMs });
  } catch (error) {
    if (error instanceof LockHeldError && params.waitMs) {
      throw new CliError({
        code: 'wallet_busy',
        message: 'A watch check is still running (it may be executing a trade).',
        hint: 'Try again in a minute.',
        cause: error
      });
    }
    throw error;
  }
}

export { LockHeldError };

// "15m", "1h", "30d": a duration in milliseconds.
export function parseDuration(params: { value: string; flag: string }): number {
  const match = /^(\d+(?:\.\d+)?)\s*(m|min|h|d)$/i.exec(params.value.trim());
  if (!match) {
    throw new CliError({
      code: 'invalid_input',
      message: `${params.flag} takes a duration like 15m, 1h or 30d, not "${params.value}".`
    });
  }
  const unit = match[2].toLowerCase();
  const ms = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000;
  return Math.round(Number(match[1]) * ms);
}

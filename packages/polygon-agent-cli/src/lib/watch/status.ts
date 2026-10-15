// What `wallet status` and `watch list` say about watches: the recurring check
// to keep, unacknowledged alerts, and whether checks are running at all.

import type { Watch } from './store.ts';

import { SESSION_ALERT_TYPES } from '../session/status.ts';
import { unacknowledgedAlerts } from './alerts.ts';
import { loadCheckState, loadWatches, MIN_INTERVAL_MS } from './store.ts';

export function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  return `${Math.round(ms / 60_000)}m`;
}

// Whether a watch still needs checks: it's active, or (cancelled or expired)
// it has an auto trade to follow up or alerts the next check must deliver.
export function needsChecks(watch: Watch): boolean {
  return watch.status === 'active' || !!watch.pendingTrade || !!watch.outbox?.length;
}

// The recurring task the assistant should keep: `watch check` at the shortest
// interval among the watches that still need checks, for as long as any does.
export function scheduleAdvice(watches: Watch[]): Record<string, unknown> | undefined {
  const needed = watches.filter(needsChecks);
  if (needed.length === 0) return undefined;
  const pending = needed.filter((watch) => watch.pendingTrade).length;
  const owed = needed.reduce((sum, watch) => sum + (watch.outbox?.length ?? 0), 0);
  const every = Math.max(MIN_INTERVAL_MS, Math.min(...needed.map((watch) => watch.everyMs)));
  return {
    command: 'polygon-agent watch check',
    every: formatDuration(every),
    ...(pending ? { pendingTrades: pending } : {}),
    ...(owed ? { undeliveredAlerts: owed } : {})
  };
}

// For `wallet status`: the watch alerts not yet acknowledged, and whether
// checks are running.
const SHOWN_ALERTS = 10;

export function watchStatus(now: Date): Record<string, unknown> {
  let watches: Watch[] = [];
  try {
    watches = loadWatches();
  } catch {
    // reported by watch list
  }
  const active = watches.filter((watch) => watch.status === 'active');
  const { lastCheckAt } = loadCheckState();
  // The allowance alerts are reported fresh by `wallet status` itself.
  const sessionKinds: readonly string[] = SESSION_ALERT_TYPES;
  const alerts = unacknowledgedAlerts().filter((alert) => !sessionKinds.includes(alert.kind));
  const owed = watches.reduce((sum, watch) => sum + (watch.outbox?.length ?? 0), 0);
  const result: Record<string, unknown> = {
    active: active.length,
    lastCheckAt: lastCheckAt ?? null,
    // Alerts a failed write left for the next check to deliver.
    ...(owed ? { undeliveredAlerts: owed } : {}),
    // The newest few; `alerts` lists them all.
    ...(alerts.length
      ? {
          unacknowledgedAlerts: alerts.slice(-SHOWN_ALERTS),
          unacknowledgedCount: alerts.length,
          ackCommand: 'polygon-agent alerts --ack'
        }
      : {})
  };
  // Active watches, and ended ones with a trade or alerts still to follow up.
  const needed = watches.filter(needsChecks);
  if (needed.length > 0) {
    const limit = 3 * Math.min(...needed.map((watch) => watch.everyMs));
    // Measured from the later of the last check and the oldest such watch
    // (a check long before any of these existed says nothing about them).
    const since = Math.max(
      lastCheckAt ? Date.parse(lastCheckAt) : 0,
      Math.min(...needed.map((watch) => Date.parse(watch.createdAt)))
    );
    if (now.getTime() - since > limit) {
      result.warning = lastCheckAt
        ? `Watches haven't been checked since ${lastCheckAt}.`
        : "Watches haven't been checked yet.";
      result.schedule = scheduleAdvice(watches);
    }
  }
  return result;
}

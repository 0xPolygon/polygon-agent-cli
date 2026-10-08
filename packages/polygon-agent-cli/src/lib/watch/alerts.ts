// alerts.jsonl in the state folder (FS §8.4): what watches and the CLI have to
// tell the user, until acknowledged. Append-only, so `alerts --ack` never waits
// for a running check: an alert line, and later an ack line naming it.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { CliError } from '../errors.ts';
import { appendJsonLine } from '../jsonl.ts';
import { ensureStorageDir, STORAGE_ROOT } from '../storage.ts';

const AlertSchema = z.object({
  id: z.string(),
  ts: z.string(),
  kind: z.string(),
  watchId: z.string().optional(),
  message: z.string(),
  command: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  // Alerts with the same key aren't raised twice (e.g. "allowance low" for one
  // approval).
  key: z.string().optional()
});
export type StoredAlert = z.infer<typeof AlertSchema>;
export type NewAlert = Omit<StoredAlert, 'id' | 'ts'>;

const AckSchema = z.object({ ts: z.string(), ack: z.string() });

function alertsFile(): string {
  return path.join(STORAGE_ROOT, 'alerts.jsonl');
}

function append(entry: Record<string, unknown>): void {
  ensureStorageDir();
  appendJsonLine({ file: alertsFile(), entry });
}

export function readAlerts(): Array<StoredAlert & { ack: boolean }> {
  let text: string;
  try {
    text = fs.readFileSync(alertsFile(), 'utf8');
  } catch {
    return [];
  }
  const alerts: StoredAlert[] = [];
  const acked = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const ack = AckSchema.safeParse(value);
    if (ack.success) {
      acked.add(ack.data.ack);
      continue;
    }
    const alert = AlertSchema.safeParse(value);
    if (alert.success) alerts.push(alert.data);
  }
  return alerts.map((alert) => ({ ...alert, ack: acked.has(alert.id) }));
}

export function unacknowledgedAlerts(): StoredAlert[] {
  return readAlerts()
    .filter((alert) => !alert.ack)
    .map(({ ack: _ack, ...alert }) => alert);
}

// Records an alert unless one with the same key exists. Returns it, or null.
export function raiseAlert(params: { alert: NewAlert; now: Date }): StoredAlert | null {
  const { key } = params.alert;
  if (key !== undefined && readAlerts().some((existing) => existing.key === key)) return null;
  const stored: StoredAlert = {
    id: `a_${randomBytes(5).toString('hex')}`,
    ts: params.now.toISOString(),
    ...params.alert
  };
  append(stored);
  return stored;
}

// Acknowledges the given alerts, or all unacknowledged ones. Returns the ids.
// An id that isn't an unacknowledged alert is refused, and nothing is written.
export function acknowledgeAlerts(params: { ids?: string[]; now: Date }): string[] {
  const open = unacknowledgedAlerts().map((alert) => alert.id);
  const unknown = (params.ids ?? []).filter((id) => !open.includes(id));
  if (unknown.length > 0) {
    throw new CliError({
      code: 'invalid_input',
      message: `Not an unacknowledged alert: ${unknown.join(', ')}.`,
      command: 'polygon-agent alerts'
    });
  }
  const ids = params.ids && params.ids.length > 0 ? params.ids : open;
  for (const id of ids) append({ ts: params.now.toISOString(), ack: id });
  return ids;
}

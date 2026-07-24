// Persisted transaction mode for write commands.
//
// 'dry-run' (default): write commands preview unless --broadcast is passed.
// 'auto': write commands broadcast immediately unless --dry-run is passed.
// Set once via `agent mode auto|dry-run` (offered during `wallet login`).

import type { Argv } from 'yargs';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureStorageDir } from './storage.ts';

export type TxMode = 'auto' | 'dry-run';

const TX_MODES: TxMode[] = ['auto', 'dry-run'];

function configPath(): string {
  return path.join(os.homedir(), '.polygon-agent', 'config.json');
}

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

export function loadTxMode(): TxMode {
  const mode = readConfig().mode;
  return TX_MODES.includes(mode as TxMode) ? (mode as TxMode) : 'dry-run';
}

export function isTxModeSet(): boolean {
  return TX_MODES.includes(readConfig().mode as TxMode);
}

export function saveTxMode(mode: TxMode): void {
  ensureStorageDir();
  const data = readConfig();
  data.mode = mode;
  fs.writeFileSync(configPath(), JSON.stringify(data, null, 2), { mode: 0o600 });
}

// Precedence: --dry-run > --broadcast/--no-broadcast > persisted mode.
export function resolveBroadcast(argv: { broadcast?: boolean; dryRun?: boolean }): boolean {
  if (argv.dryRun) return false;
  if (argv.broadcast !== undefined) return argv.broadcast;
  return loadTxMode() === 'auto';
}

// Shared flags for every write command. --broadcast has NO default so
// resolveBroadcast can tell "not passed" (undefined) from --no-broadcast.
export function withWriteFlags<T>(yargs: Argv<T>) {
  return yargs
    .option('broadcast', {
      type: 'boolean' as const,
      describe: 'Execute the transaction (overrides the persisted mode)'
    })
    .option('dry-run', {
      type: 'boolean' as const,
      describe: 'Preview only, never broadcast (overrides everything)'
    });
}

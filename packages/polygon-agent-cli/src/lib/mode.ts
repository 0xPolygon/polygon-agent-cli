// Persisted transaction mode for write commands.
//
// 'dry-run' (default): write commands preview unless --broadcast is passed.
// 'auto': write commands broadcast immediately unless --dry-run is passed.
// Set once via `agent mode auto|dry-run` (offered during `wallet login`).

import type { Argv } from 'yargs';

import { readConfig, updateConfig } from './config.ts';

export type TxMode = 'auto' | 'dry-run';

const TX_MODES: TxMode[] = ['auto', 'dry-run'];

export function loadTxMode(): TxMode {
  const mode = readConfig().mode;
  return TX_MODES.includes(mode as TxMode) ? (mode as TxMode) : 'dry-run';
}

export function isTxModeSet(): boolean {
  return TX_MODES.includes(readConfig().mode as TxMode);
}

export function saveTxMode(mode: TxMode): void {
  updateConfig({ mode });
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

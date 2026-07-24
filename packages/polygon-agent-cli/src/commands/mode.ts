import type { CommandModule } from 'yargs';

import type { TxMode } from '../lib/mode.ts';

import { isTxModeSet, loadTxMode, saveTxMode } from '../lib/mode.ts';

function jsonOut(data: Record<string, unknown>): void {
  console.log(JSON.stringify(data));
}

export const modeCommand: CommandModule = {
  command: 'mode [mode]',
  describe: 'Show or set the transaction mode (auto = broadcast immediately, dry-run = preview)',
  builder: (yargs) =>
    yargs.positional('mode', {
      type: 'string',
      choices: ['auto', 'dry-run'] as const,
      describe: 'Mode to persist; omit to show the current mode'
    }),
  handler: (argv) => {
    const requested = argv.mode as TxMode | undefined;
    if (!requested) {
      jsonOut({
        ok: true,
        mode: loadTxMode(),
        source: isTxModeSet() ? 'saved' : 'default'
      });
      return;
    }
    saveTxMode(requested);
    if (requested === 'auto') {
      jsonOut({
        ok: true,
        mode: 'auto',
        saved: true,
        warning:
          'Write commands now broadcast immediately without a preview. ' +
          'Use --dry-run on any command to preview, or revert with: agent mode dry-run'
      });
    } else {
      jsonOut({ ok: true, mode: 'dry-run', saved: true });
    }
  }
};

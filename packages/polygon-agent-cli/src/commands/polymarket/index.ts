import type { CommandModule } from 'yargs';

import { importKeyCommand, recoverCommand, setupCommand, statusCommand } from './account.ts';
import {
  bookCommand,
  eventCommand,
  historyCommand,
  marketCommand,
  marketsCommand
} from './discover.ts';
import { depositCommand, withdrawCommand } from './funds.ts';
import { activityCommand, pnlCommand, positionsCommand, redeemCommand } from './portfolio.ts';
import { buyCommand, cancelCommand, ordersCommand, sellCommand } from './trade.ts';

// Old command names stay callable (hidden from --help) so existing scripts and skills keep working.
const hiddenAliases: CommandModule[] = [
  {
    ...buyCommand,
    command: 'clob-buy <ref> <outcome> <amount>',
    describe: false,
    aliases: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (argv: any) => buyCommand.handler({ ...argv, usd: argv.amount })
  },
  { ...statusCommand, command: 'proxy-wallet', describe: false, aliases: [] },
  { ...setupCommand, command: 'approve', describe: false, aliases: [] },
  { ...importKeyCommand, command: 'set-key <privateKey>', describe: false, aliases: [] }
];

const visibleCommands: CommandModule[] = [
  setupCommand,
  statusCommand,
  importKeyCommand,
  recoverCommand,
  depositCommand,
  withdrawCommand,
  marketsCommand,
  eventCommand,
  marketCommand,
  bookCommand,
  historyCommand,
  buyCommand,
  sellCommand,
  ordersCommand,
  cancelCommand,
  positionsCommand,
  redeemCommand,
  activityCommand,
  pnlCommand
];

export const polymarketCommand: CommandModule = {
  command: 'polymarket',
  describe: 'Prediction markets on Polymarket: discover, trade, deposit, withdraw, redeem',
  builder: (y) => {
    let out = y;
    for (const c of [...visibleCommands, ...hiddenAliases]) out = out.command(c);
    return out.demandCommand(1, '').showHelpOnFail(true);
  },
  handler: () => {}
};

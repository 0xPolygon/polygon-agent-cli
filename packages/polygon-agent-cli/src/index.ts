#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import {
  feedbackCommand,
  identityCommand,
  registerCommand,
  reputationCommand,
  reviewsCommand
} from './commands/agent.ts';
import { modeCommand } from './commands/mode.ts';
import {
  balancesCommand,
  callCommand,
  depositCommand,
  fundCommand,
  sendCommand,
  sendNativeCommand,
  sendTokenCommand,
  swapCommand,
  withdrawCommand,
  x402PayCommand
} from './commands/operations.ts';
import { polymarketCommand } from './commands/polymarket.ts';
import { priceCommand } from './commands/price.ts';
import { setupCommand } from './commands/setup.ts';
import { walletCommand } from './commands/wallet.ts';
import { alertsCommand, watchCommand } from './commands/watch.ts';
import { skillsCommand, updateCommand, workspaceCommand } from './commands/workspace.ts';
import { bigintReplacer, failureJson } from './lib/errors.ts';
import { bootstrapOmsConfig } from './lib/storage.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));

// Auto-load OMS V3 credentials from builder.json if not already in env
bootstrapOmsConfig();

// The CLI ships two bin names ("agent" is the primary, "polygon-agent" the
// long-form alias); help and usage text follow whichever one was invoked.
const invokedAs = path.basename(process.argv[1] ?? '');

const parser = yargs(hideBin(process.argv))
  .scriptName(invokedAs === 'agent' ? 'agent' : 'polygon-agent')
  .version(pkg.version)
  .command(setupCommand)
  .command(modeCommand)
  .command(walletCommand)
  .command(balancesCommand)
  .command(fundCommand)
  .command(sendCommand)
  .command(sendNativeCommand)
  .command(sendTokenCommand)
  .command(callCommand)
  .command(swapCommand)
  .command(depositCommand)
  .command(withdrawCommand)
  .command(x402PayCommand)
  .command(priceCommand)
  .command(watchCommand)
  .command(alertsCommand)
  .command(registerCommand)
  .command(identityCommand)
  .command(reputationCommand)
  .command(reviewsCommand)
  .command(feedbackCommand)
  .command(polymarketCommand)
  .command(workspaceCommand)
  .command(skillsCommand)
  .command(updateCommand);

parser
  .demandCommand(1, '')
  .showHelpOnFail(true)
  .strict()
  .help()
  .fail((msg, err, yargs) => {
    if (err) {
      console.error(JSON.stringify(failureJson(err), bigintReplacer, 2));
    } else {
      yargs.showHelp('error');
      if (msg) console.error(`\n${msg}`);
    }
    process.exit(1);
  })
  .parseAsync()
  .catch((err: unknown) => {
    console.error(JSON.stringify(failureJson(err), bigintReplacer, 2));
    process.exit(1);
  });

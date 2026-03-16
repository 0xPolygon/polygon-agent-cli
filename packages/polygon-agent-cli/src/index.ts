#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { agentCommand } from './commands/agent.ts';
import {
  balancesCommand,
  depositCommand,
  fundCommand,
  nftsCommand,
  receiptCommand,
  sendCommand,
  sendNativeCommand,
  sendTokenCommand,
  swapCommand,
  txHistoryCommand,
  watchCommand,
  webhooksCommand,
  x402PayCommand
} from './commands/operations.ts';
import { setupCommand } from './commands/setup.ts';
import { walletCommand } from './commands/wallet.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));

// Legacy aliases — hidden commands that map to the new structure
const legacyAliases = [
  {
    command: 'register',
    describe: false as const,
    handler: async () => {
      const { registerAgent } = await import('./commands/agent-legacy.ts');
      await registerAgent();
    }
  },
  {
    command: 'agent-wallet',
    describe: false as const,
    handler: async () => {
      const { getAgentWallet } = await import('./commands/agent-legacy.ts');
      await getAgentWallet();
    }
  },
  {
    command: 'agent-metadata',
    describe: false as const,
    handler: async () => {
      const { getMetadata } = await import('./commands/agent-legacy.ts');
      await getMetadata();
    }
  },
  {
    command: 'reputation',
    describe: false as const,
    handler: async () => {
      const { getReputation } = await import('./commands/agent-legacy.ts');
      await getReputation();
    }
  },
  {
    command: 'give-feedback',
    describe: false as const,
    handler: async () => {
      const { giveFeedback } = await import('./commands/agent-legacy.ts');
      await giveFeedback();
    }
  },
  {
    command: 'read-feedback',
    describe: false as const,
    handler: async () => {
      const { readAllFeedback } = await import('./commands/agent-legacy.ts');
      await readAllFeedback();
    }
  }
];

const parser = yargs(hideBin(process.argv))
  .scriptName('polygon-agent')
  .version(pkg.version)
  .command(setupCommand)
  .command(walletCommand)
  .command(balancesCommand)
  .command(fundCommand)
  .command(sendCommand)
  .command(sendNativeCommand)
  .command(sendTokenCommand)
  .command(swapCommand)
  .command(depositCommand)
  .command(txHistoryCommand)
  .command(nftsCommand)
  .command(receiptCommand)
  .command(watchCommand)
  .command(webhooksCommand)
  .command(x402PayCommand)
  .command(agentCommand);

// Register legacy aliases
for (const alias of legacyAliases) {
  parser.command(alias);
}

parser
  .demandCommand(1, '')
  .showHelpOnFail(true)
  .strict()
  .help()
  .fail((msg, err, yargs) => {
    if (err) {
      console.error(JSON.stringify({ ok: false, error: err.message, stack: err.stack }, null, 2));
    } else {
      yargs.showHelp('error');
      if (msg) console.error(`\n${msg}`);
    }
    process.exit(1);
  })
  .parseAsync()
  .catch((err: unknown) => {
    console.error(
      JSON.stringify(
        { ok: false, error: (err as Error).message, stack: (err as Error).stack },
        null,
        2
      )
    );
    process.exit(1);
  });

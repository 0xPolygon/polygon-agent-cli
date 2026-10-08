// setup / status / import-key: the Polymarket trading account for an OMS wallet.

import type { CommandModule } from 'yargs';

import { resolveBroadcast, withWriteFlags } from '../../lib/mode.ts';
import {
  getTradingClient,
  importLegacyKey,
  loadAccount,
  planSetup,
  pusdBalance,
  setupAccount
} from '../../lib/polymarket/account.ts';
import { formatUnits6 } from '../../lib/polymarket/amounts.ts';
import { loadPending } from '../../lib/polymarket/deposits.ts';
import { assertCanTrade, checkRegion } from '../../lib/polymarket/region.ts';
import { mapSdkError } from '../../lib/polymarket/sdk.ts';
import { fail, ok, omsAddress, walletOption } from './shared.ts';

const SETUP_STEPS = [
  'create trading key',
  'mint builder key',
  'deploy Deposit Wallet (gasless)',
  'set trading approvals (gasless)'
];

type SetupArgs = { wallet: string; broadcast?: boolean; dryRun?: boolean };

async function handleSetup(argv: SetupArgs): Promise<void> {
  try {
    const broadcast = resolveBroadcast(argv);
    await omsAddress(argv.wallet);
    assertCanTrade(await checkRegion());
    if (!broadcast) {
      const { exists, account } = planSetup(argv.wallet);
      ok({
        dryRun: true,
        exists,
        ...(account ? { account } : {}),
        // Approvals are re-checked on every run; everything before them is done once.
        steps: exists ? SETUP_STEPS.slice(3) : SETUP_STEPS
      });
      return;
    }
    const { account, created, approvalsSet } = await setupAccount(argv.wallet);
    ok({
      account: { kind: account.kind, wallet: account.wallet, signer: account.signer },
      created,
      approvalsSet,
      next: 'agent polymarket deposit <usd> --broadcast'
    });
  } catch (err) {
    fail(err, { stack: true });
  }
}

async function handleStatus(argv: { wallet: string }): Promise<void> {
  try {
    const account = loadAccount(argv.wallet);
    if (!account) {
      ok({ setUp: false, next: 'agent polymarket setup --broadcast' });
      return;
    }
    const client = await getTradingClient(argv.wallet);
    try {
      const [pusd, approvals, region, orders, redeemable] = await Promise.all([
        pusdBalance(argv.wallet),
        client.fetchTradingApprovalsState(),
        checkRegion(client),
        client.listOpenOrders().firstPage(),
        client.listPositions({ status: 'REDEEMABLE' }).firstPage()
      ]);
      const rows = redeemable.items as Array<{ currentValue: string }>;
      const redeemableUsd = rows.reduce((sum, p) => sum + Number(p.currentValue), 0);
      const pending = loadPending(argv.wallet);
      ok({
        setUp: true,
        account: { kind: account.kind, wallet: account.wallet },
        pusd: formatUnits6(pusd),
        approvals: approvals.isFullyApproved,
        region: { country: region.country, blocked: region.blocked, closeOnly: region.closeOnly },
        openOrders: orders.items.length,
        redeemable: { count: rows.length, valueUsd: String(redeemableUsd) },
        ...(pending
          ? {
              pendingDeposit: {
                amountUsd: formatUnits6(pending.amountUnits),
                txHash: pending.txHash,
                sentAt: pending.sentAt
              }
            }
          : {})
      });
    } catch (err) {
      throw mapSdkError(err);
    }
  } catch (err) {
    fail(err, { stack: true });
  }
}

async function handleImportKey(argv: { privateKey: string; wallet: string }): Promise<void> {
  try {
    const account = await importLegacyKey(argv.wallet, argv.privateKey);
    ok({
      account: { kind: account.kind, wallet: account.wallet, signer: account.signer },
      note: 'This is a legacy proxy account: it trades through the Polymarket proxy wallet that belongs to the imported key.'
    });
  } catch (err) {
    fail(err);
  }
}

export const setupCommand: CommandModule = {
  command: 'setup',
  describe: 'Create the Polymarket trading account (key, builder key, Deposit Wallet, approvals)',
  builder: (y) => withWriteFlags(walletOption(y)),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleSetup(argv as any)
};

export const statusCommand: CommandModule = {
  command: 'status',
  describe: 'Show the Polymarket account: balance, approvals, region, orders, redeemable positions',
  builder: (y) => walletOption(y),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleStatus(argv as any)
};

export const importKeyCommand: CommandModule = {
  command: 'import-key <privateKey>',
  describe: 'Import an existing Polymarket private key as a legacy proxy account',
  builder: (y) =>
    walletOption(y).positional('privateKey', {
      type: 'string',
      demandOption: true,
      describe: 'Hex private key (never printed)'
    }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleImportKey(argv as any)
};

// setup / status / import-key: the Polymarket trading account for an OMS wallet.

import type { CommandModule } from 'yargs';

import { resolveBroadcast, withWriteFlags } from '../../lib/mode.ts';
import { getOmsClient } from '../../lib/oms-client.ts';
import { ensureMainWallet } from '../../lib/oms-tx.ts';
import {
  ensureTradingKey,
  getTradingClient,
  hasLocalKey,
  importLegacyKey,
  legacyNegRiskApproved,
  loadAccount,
  planSetup,
  pusdBalance,
  readBackup,
  setupAccount,
  writeBackup
} from '../../lib/polymarket/account.ts';
import { formatUnits6 } from '../../lib/polymarket/amounts.ts';
import { loadPending } from '../../lib/polymarket/deposits.ts';
import { backupTradingKey } from '../../lib/polymarket/oms-key.ts';
import { assertCanTrade, checkRegion } from '../../lib/polymarket/region.ts';
import { mapSdkError } from '../../lib/polymarket/sdk.ts';
import { loadOmsWalletPointer } from '../../lib/storage.ts';
import { collectRedeemable, fail, ok, omsAddress, walletOption } from './shared.ts';

const SETUP_STEPS = [
  'create trading key',
  'mint builder key',
  'deploy Deposit Wallet (gasless)',
  'set trading approvals (gasless)'
];
const BACKUP_STEP = 'back up the trading key to OMS';
const LEGACY_STEP = 'approve the legacy NegRiskAdapter for neg-risk markets (gasless)';

type SetupArgs = { wallet: string; broadcast?: boolean; dryRun?: boolean };

const NOT_SIGNED_IN = { backedUp: false, hint: 'agent wallet login' };

// Owner mode: the pointer isn't a session-only grant. Session mode backs up via owner requests.
async function isOwnerMode(wallet: string): Promise<boolean> {
  const pointer = await loadOmsWalletPointer(wallet);
  return !!pointer && pointer.access !== 'session';
}

function backupSummary(wallet: string): Record<string, unknown> {
  const b = readBackup(wallet);
  return b ? { backedUp: true, omsWalletId: b.omsWalletId } : { backedUp: false };
}

// Runs after the account exists, so a failure here is safe to retry: backup is idempotent.
async function backUpInOwnerMode(wallet: string): Promise<Record<string, unknown>> {
  const w = getOmsClient(wallet).wallet;
  if (!w.walletAddress) return NOT_SIGNED_IN;
  const key = await ensureTradingKey(wallet);
  try {
    const res = await backupTradingKey(w, key);
    writeBackup(wallet, {
      omsWalletId: res.omsWalletId,
      address: res.address,
      at: new Date().toISOString()
    });
    return { omsWalletId: res.omsWalletId, imported: res.imported };
  } finally {
    await ensureMainWallet(wallet);
  }
}

async function handleSetup(argv: SetupArgs): Promise<void> {
  try {
    const broadcast = resolveBroadcast(argv);
    await omsAddress(argv.wallet);
    assertCanTrade(await checkRegion());
    if (!broadcast) {
      const { exists, account } = planSetup(argv.wallet);
      // The legacy approvals are only listed when an existing account lacks them.
      const legacyMissing = exists
        ? !(await legacyNegRiskApproved(await getTradingClient(argv.wallet)))
        : true;
      ok({
        dryRun: true,
        exists,
        ...(account ? { account } : {}),
        // Approvals are re-checked on every run; everything before them is done once.
        steps: [
          ...(exists ? SETUP_STEPS.slice(3) : SETUP_STEPS),
          ...(legacyMissing ? [LEGACY_STEP] : []),
          ...(!readBackup(argv.wallet) && (await isOwnerMode(argv.wallet)) ? [BACKUP_STEP] : [])
        ]
      });
      return;
    }
    const { account, created, approvalsSet } = await setupAccount(argv.wallet);
    const backup = (await isOwnerMode(argv.wallet))
      ? await backUpInOwnerMode(argv.wallet)
      : backupSummary(argv.wallet);
    ok({
      account: { kind: account.kind, wallet: account.wallet, signer: account.signer },
      created,
      approvalsSet,
      backup,
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
      const [pusd, approvals, legacyApproved, region, orders, redeemable] = await Promise.all([
        pusdBalance(argv.wallet),
        client.fetchTradingApprovalsState(),
        legacyNegRiskApproved(client).catch(() => null),
        checkRegion(client),
        client.listOpenOrders().firstPage(),
        collectRedeemable(client)
      ]);
      const rows = redeemable.items as Array<{ currentValue: string }>;
      const redeemableUsd = rows.reduce((sum, p) => sum + Number(p.currentValue), 0);
      const pending = loadPending(argv.wallet);
      ok({
        setUp: true,
        account: { kind: account.kind, wallet: account.wallet },
        signer: hasLocalKey(argv.wallet) ? 'local' : 'oms',
        backup: backupSummary(argv.wallet),
        pusd: formatUnits6(pusd),
        approvals: approvals.isFullyApproved && legacyApproved === true,
        ...(legacyApproved === null ? { approvalsCheck: 'unavailable' } : {}),
        region: { country: region.country, blocked: region.blocked, closeOnly: region.closeOnly },
        openOrders: orders.items.length,
        redeemable: {
          count: rows.length,
          valueUsd: String(redeemableUsd),
          ...(redeemable.truncated ? { truncated: true } : {})
        },
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
    const { account, builderKey, warning } = await importLegacyKey(argv.wallet, argv.privateKey);
    ok({
      account: { kind: account.kind, wallet: account.wallet, signer: account.signer },
      builderKey,
      note: 'This is a legacy proxy account: it trades through the Polymarket proxy wallet that belongs to the imported key. withdraw moves only its pUSD; USDC.e left in the proxy is not moved.',
      ...(warning ? { warning } : {})
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

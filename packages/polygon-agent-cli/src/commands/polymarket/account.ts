// setup / status / import-key: the Polymarket trading account for an OMS wallet.

import type { CommandModule } from 'yargs';

import { CliError } from '../../lib/errors.ts';
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
  localTradingKeyAddresses,
  planSetup,
  pusdBalance,
  readBackup,
  recoverOtherKey,
  restoreFromOms,
  setupAccount,
  writeBackup
} from '../../lib/polymarket/account.ts';
import { formatUnits6 } from '../../lib/polymarket/amounts.ts';
import { loadPending } from '../../lib/polymarket/deposits.ts';
import {
  backupTradingKey,
  findTradingKeyWallet,
  installTradingKeyReference,
  TRADING_KEY_REFERENCE
} from '../../lib/polymarket/oms-key.ts';
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
const RESTORE_STEP = 'restore the trading key from OMS';
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
// A failed backup never fails setup, and a failed main-wallet restore never hides the
// backup outcome: both are reported in the result.
async function backUpInOwnerMode(wallet: string): Promise<Record<string, unknown>> {
  const w = getOmsClient(wallet).wallet;
  if (!w.walletAddress) return NOT_SIGNED_IN;
  const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
  let result: Record<string, unknown>;
  try {
    const key = await ensureTradingKey(wallet);
    const res = await backupTradingKey(w, key, installTradingKeyReference());
    writeBackup(wallet, {
      omsWalletId: res.omsWalletId,
      address: res.address,
      at: new Date().toISOString(),
      kind: loadAccount(wallet)?.kind ?? 'deposit-wallet'
    });
    result = { backedUp: true, omsWalletId: res.omsWalletId, imported: res.imported };
  } catch (error) {
    result = {
      backedUp: false,
      error: errorText(error),
      hint: 'Run polymarket setup --broadcast again to retry the backup.'
    };
  }
  try {
    await ensureMainWallet(wallet);
  } catch (error) {
    result = { ...result, mainWalletError: errorText(error) };
  }
  return result;
}

// Owner mode with the local key missing: OMS may hold it (a wiped machine, or a key moved
// aside). Then the account is restored and signed through OMS; a new key is never made over
// it. Returns null only when OMS holds no trading key, so setup may create one.
async function restoreInOwnerMode(wallet: string): Promise<Record<string, unknown> | null> {
  const w = getOmsClient(wallet).wallet;
  if (!w.walletAddress) {
    throw new CliError({
      code: 'not_set_up',
      message:
        "The Polymarket key is not on this machine, and OMS can't be checked for a backup while signed out.",
      hint: 'Sign in with agent wallet login, then run setup again.'
    });
  }
  let restored: Awaited<ReturnType<typeof restoreFromOms>> | null = null;
  let failure: unknown;
  let mainWalletError: string | undefined;
  try {
    const known = loadAccount(wallet)?.signer ?? readBackup(wallet)?.address;
    const found = await findTradingKeyWallet(
      w,
      known ? { address: known } : { reference: installTradingKeyReference() }
    );
    if (found) restored = await restoreFromOms({ wallet, owner: w, target: found });
  } catch (error) {
    failure = error;
  }
  try {
    await ensureMainWallet(wallet);
  } catch (error) {
    // Never masks the restore's own failure; reported alongside a good restore.
    mainWalletError = error instanceof Error ? error.message : String(error);
  }
  if (failure) throw failure;
  if (!restored) return null;
  const { account, approvalsSet, backup } = restored;
  return {
    account: { kind: account.kind, wallet: account.wallet, signer: account.signer },
    created: false,
    restored: true,
    signer: 'oms',
    approvalsSet,
    backup: { backedUp: true, omsWalletId: backup.omsWalletId },
    ...(mainWalletError ? { mainWalletError } : {}),
    next: 'agent polymarket deposit <usd> --broadcast'
  };
}

// Dry run, owner mode, no local key: whether `setup --broadcast` would restore this install's
// key from OMS rather than create one. Read-only: one listWallets, no wallet switch, no
// signing. Signed out, or on any error, it reports false (the broadcast run checks again).
async function wouldRestoreFromOms(wallet: string): Promise<boolean> {
  if (hasLocalKey(wallet) || !(await isOwnerMode(wallet))) return false;
  const w = getOmsClient(wallet).wallet;
  if (!w.walletAddress) return false;
  try {
    const known = loadAccount(wallet)?.signer ?? readBackup(wallet)?.address;
    const found = await findTradingKeyWallet(
      w,
      known ? { address: known } : { reference: installTradingKeyReference() }
    );
    return found !== null;
  } catch {
    return false;
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
      // A restore records the OMS backup itself, so it needs no separate backup step.
      const restore = !exists && (await wouldRestoreFromOms(argv.wallet));
      ok({
        dryRun: true,
        exists,
        ...(account ? { account } : {}),
        // Approvals are re-checked on every run; everything before them is done once.
        steps: [
          ...(exists
            ? SETUP_STEPS.slice(3)
            : restore
              ? [RESTORE_STEP, ...SETUP_STEPS.slice(1)]
              : SETUP_STEPS),
          ...(legacyMissing ? [LEGACY_STEP] : []),
          ...(!restore && !readBackup(argv.wallet) && (await isOwnerMode(argv.wallet))
            ? [BACKUP_STEP]
            : [])
        ]
      });
      return;
    }
    if ((await isOwnerMode(argv.wallet)) && !hasLocalKey(argv.wallet)) {
      const restored = await restoreInOwnerMode(argv.wallet);
      if (restored) {
        ok(restored);
        return;
      }
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

// Imported Polymarket trading keys in the OMS account that this install doesn't track: other
// installs' keys, or one from before a reinstall. Read-only (listWallets, no switching), and
// it never fails status: any error, or no owner session, gives an empty list.
async function otherTradingKeys(
  wallet: string
): Promise<Array<{ address: string; reference: string }>> {
  try {
    if (!(await isOwnerMode(wallet))) return [];
    const w = getOmsClient(wallet).wallet;
    if (!w.walletAddress) return [];
    const mine = localTradingKeyAddresses();
    return (await w.listWallets())
      .filter(
        (x) =>
          x.keyOrigin === 'imported' &&
          typeof x.reference === 'string' &&
          x.reference.startsWith(TRADING_KEY_REFERENCE) &&
          !mine.has(x.address.toLowerCase())
      )
      .map((x) => ({ address: x.address, reference: x.reference as string }));
  } catch {
    return [];
  }
}

// Only wallets labelled as Polymarket trading keys can be recovered, same as `otherTradingKeys`.
async function isPolymarketKey(
  w: { listWallets(): Promise<Array<{ address: string; keyOrigin?: string; reference?: string }>> },
  address: string
): Promise<boolean> {
  return (await w.listWallets()).some(
    (x) =>
      x.keyOrigin === 'imported' &&
      x.address.toLowerCase() === address.toLowerCase() &&
      typeof x.reference === 'string' &&
      x.reference.startsWith(TRADING_KEY_REFERENCE)
  );
}

async function otherKeysField(wallet: string): Promise<Record<string, unknown>> {
  const keys = await otherTradingKeys(wallet);
  return keys.length > 0 ? { otherTradingKeys: keys } : {};
}

async function handleStatus(argv: { wallet: string }): Promise<void> {
  try {
    const account = loadAccount(argv.wallet);
    if (!account) {
      ok({
        setUp: false,
        ...(await otherKeysField(argv.wallet)),
        next: 'agent polymarket setup --broadcast'
      });
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
        ...(await otherKeysField(argv.wallet)),
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

type RecoverArgs = { address: string; wallet: string; broadcast?: boolean; dryRun?: boolean };

// Owner mode only: the explicit escape hatch for a funded trading key this install can't claim
// automatically. Moves that account's pUSD to the main OMS wallet; touches no local records.
async function handleRecover(argv: RecoverArgs): Promise<void> {
  try {
    const broadcast = resolveBroadcast(argv);
    const pointer = await loadOmsWalletPointer(argv.wallet);
    if (pointer?.access === 'session') {
      throw new CliError({
        code: 'owner_required',
        message: 'Recovering another Polymarket key needs an owner sign-in.',
        hint: 'Run this from an owner install (agent wallet login)'
      });
    }
    const w = pointer ? getOmsClient(argv.wallet).wallet : null;
    if (!pointer || !w?.walletAddress) {
      throw new CliError({
        code: 'not_set_up',
        message: 'No owner session is live for this wallet.',
        hint: 'agent wallet login'
      });
    }
    let result: Record<string, unknown>;
    try {
      const target = await findTradingKeyWallet(w, { address: argv.address });
      if (!target || !(await isPolymarketKey(w, target.address))) {
        throw new CliError({
          code: 'invalid_input',
          message: 'No Polymarket trading key with that address in your OMS account.'
        });
      }
      if (localTradingKeyAddresses().has(target.address.toLowerCase())) {
        throw new CliError({
          code: 'invalid_input',
          message: "That is this install's own trading key.",
          hint: 'Use agent polymarket withdraw instead.'
        });
      }
      if (broadcast) assertCanTrade(await checkRegion());
      const res = await recoverOtherKey({
        owner: w,
        target,
        mainAddress: pointer.walletAddress,
        broadcast
      });
      const { positionsLeft, ...rest } = res;
      result = broadcast
        ? { ...rest, positionsLeft, to: pointer.walletAddress }
        : { dryRun: true, ...rest, to: pointer.walletAddress, positions: positionsLeft };
    } catch (error) {
      // Never masks the original error.
      try {
        await ensureMainWallet(argv.wallet);
      } catch {
        // The original error is the one worth reporting.
      }
      throw error;
    }
    try {
      await ensureMainWallet(argv.wallet);
    } catch (error) {
      result.mainWalletError = error instanceof Error ? error.message : String(error);
    }
    ok(result);
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

export const recoverCommand: CommandModule = {
  command: 'recover <address>',
  describe:
    "Move the cash of a Polymarket trading key this install doesn't track back to your OMS wallet (owner mode)",
  builder: (y) =>
    withWriteFlags(walletOption(y)).positional('address', {
      type: 'string',
      demandOption: true,
      describe: 'Trading key address, from status.otherTradingKeys'
    }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleRecover(argv as any)
};

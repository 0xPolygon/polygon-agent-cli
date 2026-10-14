// setup / status: the Polymarket trading account for an agent wallet.

import type { CommandModule } from 'yargs';

import type { OtherKeyRecovery } from '../../lib/polymarket/account.ts';
import type { OmsWalletLike } from '../../lib/polymarket/oms-key.ts';

import { CliError } from '../../lib/errors.ts';
import { resolveBroadcast, withWriteFlags } from '../../lib/mode.ts';
import { getOmsClient } from '../../lib/oms-client.ts';
import { ensureMainWallet } from '../../lib/oms-tx.ts';
import {
  ensureTradingKey,
  getTradingClient,
  hasLocalKey,
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
  listTradingKeyWallets,
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
const DETECT_STEP =
  'restore the backed-up trading key that holds funds or positions, or create one if none does';
const LEGACY_STEP = 'approve the legacy NegRiskAdapter for neg-risk markets (gasless)';

type SetupArgs = {
  wallet: string;
  broadcast?: boolean;
  dryRun?: boolean;
  from?: string;
  new?: boolean;
};
type RestoreOpts = { from?: string; new?: boolean };

const sameAddress = (a: string | undefined, b: string | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

// Backed-up trading keys this machine doesn't use: other installs', or a lost install's.
async function untrackedTradingKeys(
  w: OmsWalletLike
): Promise<Array<{ id: string; address: string; reference: string }>> {
  const mine = localTradingKeyAddresses();
  return (await listTradingKeyWallets(w)).filter((x) => !mine.has(x.address.toLowerCase()));
}

// Anything a new account would leave behind: pUSD, open positions, a funded legacy proxy, or
// a read that failed (then the key can't be shown to be empty).
function holdsSomething(r: OtherKeyRecovery): boolean {
  return (
    Number(r.pusd) > 0 ||
    !!r.legacyProxy ||
    !!r.legacyProxyError ||
    !Array.isArray(r.positionsLeft) ||
    r.positionsLeft.length > 0
  );
}

const NOT_SIGNED_IN = { backedUp: false, hint: 'agent wallet login --owner' };

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
// it. Returns null only when a new key is safe (see restoreTarget), so setup may create one.
async function restoreInOwnerMode(
  wallet: string,
  opts: RestoreOpts
): Promise<Record<string, unknown> | null> {
  const w = getOmsClient(wallet).wallet;
  if (!w.walletAddress) {
    throw new CliError({
      code: 'not_set_up',
      message:
        "The Polymarket key is not on this machine, and OMS can't be checked for a backup while signed out.",
      hint: 'Sign in with agent wallet login --owner, then run setup again.'
    });
  }
  let restored: Awaited<ReturnType<typeof restoreFromOms>> | null = null;
  let failure: unknown;
  let mainWalletError: string | undefined;
  try {
    const found = await restoreTarget(wallet, w, opts);
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

// Which backed-up key setup restores, in order: the one the local records name; the one
// --from names; this install's own label; otherwise the only other backed-up key that holds
// funds or positions (a reinstall under another name, or a new machine). Null means a new
// key is safe: --new, or no backed-up key holds anything.
async function restoreTarget(
  wallet: string,
  w: OmsWalletLike,
  opts: RestoreOpts
): Promise<{ id: string; address: string } | null> {
  const known = loadAccount(wallet)?.signer ?? readBackup(wallet)?.address;
  if (known) {
    if (opts.from && !sameAddress(opts.from, known)) {
      throw new CliError({
        code: 'invalid_input',
        message: `This install's records name trading key ${known}, not ${opts.from}.`
      });
    }
    return findTradingKeyWallet(w, { address: known });
  }
  if (opts.from) {
    const target = (await listTradingKeyWallets(w)).find((x) => sameAddress(x.address, opts.from));
    if (!target) {
      throw new CliError({
        code: 'invalid_input',
        message: `OMS holds no Polymarket trading key with address ${opts.from}.`,
        hint: 'agent polymarket status lists them under otherTradingKeys'
      });
    }
    return target;
  }
  const own = await findTradingKeyWallet(w, { reference: installTradingKeyReference() });
  if (own || opts.new) return own;
  return fundedOtherKey(w);
}

// Probes each untracked backed-up key's account read-only, one at a time (the OMS signer is
// not reentrant). One that holds something is restored; several need --from.
async function fundedOtherKey(w: OmsWalletLike): Promise<{ id: string; address: string } | null> {
  const funded: Array<
    { id: string; address: string; reference: string } & Record<string, unknown>
  > = [];
  for (const key of await untrackedTradingKeys(w)) {
    try {
      const r = await recoverOtherKey({
        owner: w,
        target: key,
        mainAddress: w.walletAddress as string,
        broadcast: false
      });
      if (!holdsSomething(r)) continue;
      funded.push({
        ...key,
        account: r.account,
        pusd: r.pusd,
        positions: Array.isArray(r.positionsLeft) ? r.positionsLeft.length : null
      });
    } catch (error) {
      funded.push({ ...key, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (funded.length === 1 && funded[0].error === undefined) {
    return { id: funded[0].id, address: funded[0].address };
  }
  if (funded.length === 0) return null;
  throw new CliError({
    code: 'ambiguous_trading_key',
    message:
      funded.length === 1
        ? `Couldn't read the account of backed-up trading key ${funded[0].address}, so setup won't make a new one over it.`
        : `${funded.length} backed-up Polymarket trading keys hold funds or positions.`,
    hint: 'Pick one with: agent polymarket setup --broadcast --from <address>, or make a new account with --new',
    details: {
      tradingKeys: funded.map(({ id: _id, ...rest }) => rest)
    }
  });
}

// Dry run, owner mode, no local key: the restore step `setup --broadcast` would run instead of
// creating a key, if any. Read-only: listWallets only, no wallet switch, no signing (the
// funds check on other installs' keys runs on broadcast). Signed out, or on any error, it is
// null (the broadcast run checks again).
async function plannedRestoreStep(wallet: string, opts: RestoreOpts): Promise<string | null> {
  if (hasLocalKey(wallet) || !(await isOwnerMode(wallet))) return null;
  const w = getOmsClient(wallet).wallet;
  if (!w.walletAddress) return null;
  try {
    const known = loadAccount(wallet)?.signer ?? readBackup(wallet)?.address;
    const address = known ?? opts.from;
    const found = await findTradingKeyWallet(
      w,
      address ? { address } : { reference: installTradingKeyReference() }
    );
    if (found) return RESTORE_STEP;
    if (address || opts.new) return null;
    return (await untrackedTradingKeys(w)).length > 0 ? DETECT_STEP : null;
  } catch {
    return null;
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
      const restore = exists ? null : await plannedRestoreStep(argv.wallet, argv);
      ok({
        dryRun: true,
        exists,
        ...(account ? { account } : {}),
        // Approvals are re-checked on every run; everything before them is done once.
        steps: [
          ...(exists
            ? SETUP_STEPS.slice(3)
            : restore
              ? [restore, ...SETUP_STEPS.slice(1)]
              : SETUP_STEPS),
          ...(legacyMissing ? [LEGACY_STEP] : []),
          ...(!restore && !readBackup(argv.wallet) && (await isOwnerMode(argv.wallet))
            ? [BACKUP_STEP]
            : [])
        ]
      });
      return;
    }
    if (argv.from && hasLocalKey(argv.wallet)) {
      throw new CliError({
        code: 'invalid_input',
        message: `This install already has its own trading key, so --from can't restore ${argv.from}.`,
        hint: `To move that key's cash to the agent wallet instead: agent polymarket recover ${argv.from}`
      });
    }
    if ((await isOwnerMode(argv.wallet)) && !hasLocalKey(argv.wallet)) {
      const restored = await restoreInOwnerMode(argv.wallet, argv);
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
// automatically. Moves that account's pUSD to the main agent wallet; touches no local records.
async function handleRecover(argv: RecoverArgs): Promise<void> {
  try {
    const broadcast = resolveBroadcast(argv);
    const pointer = await loadOmsWalletPointer(argv.wallet);
    if (pointer?.access === 'session') {
      throw new CliError({
        code: 'owner_required',
        message: 'Recovering another Polymarket key needs an owner sign-in.',
        hint: 'Run this from an owner install (agent wallet login --owner)'
      });
    }
    const w = pointer ? getOmsClient(argv.wallet).wallet : null;
    if (!pointer || !w?.walletAddress) {
      throw new CliError({
        code: 'not_set_up',
        message: 'No owner session is live for this wallet.',
        hint: 'agent wallet login --owner'
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

export const setupCommand: CommandModule = {
  command: 'setup',
  describe: 'Create the Polymarket trading account (key, builder key, Deposit Wallet, approvals)',
  builder: (y) =>
    withWriteFlags(walletOption(y))
      .option('from', {
        type: 'string',
        describe:
          'Owner mode, no local key: restore this backed-up trading key (an address from status.otherTradingKeys)'
      })
      .option('new', {
        type: 'boolean',
        describe:
          "Owner mode, no local key: make a new account even when another install's backed-up key holds funds"
      })
      .conflicts('from', 'new'),
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

export const recoverCommand: CommandModule = {
  command: 'recover <address>',
  describe:
    "Move the cash of a Polymarket trading key this install doesn't track back to your agent wallet (owner mode)",
  builder: (y) =>
    withWriteFlags(walletOption(y)).positional('address', {
      type: 'string',
      demandOption: true,
      describe: 'Trading key address, from status.otherTradingKeys'
    }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleRecover(argv as any)
};

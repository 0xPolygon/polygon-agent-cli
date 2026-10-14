// Best-effort step run while the owner is signed in (a login, or any owner request): make sure
// this install can use the user's one Polymarket account. It never throws, so it can never fail
// the sign-in it rides on.
//
// One trading key per user, backed up in OMS under the shared label. An install that has the
// key locally backs it up. One that doesn't finds the account's key in OMS: kept signed in, it
// restores the account and signs through OMS; otherwise, once this sign-in ends it can't sign
// as that key, so it records the account and says one more sign-in uses it here. A key is never
// replaced, and no second account is made over one that holds anything.

import { privateKeyToAccount } from 'viem/accounts';

import type { RecoveryResult } from './account.ts';
import type { ExistingAccount, FundedKey } from './find-key.ts';
import type { OmsWalletLike } from './oms-key.ts';

import { CliError } from '../errors.ts';
import {
  ensureTradingKey,
  hasLocalKey,
  localTradingKeyAddresses,
  loadAccount,
  previousTradingKeyAddresses,
  readBackup,
  restoreFromOms,
  sweepOldKey,
  writeBackup
} from './account.ts';
import {
  clearExistingAccount,
  existingAccountMessage,
  existingAccounts,
  findAccountKey,
  holdsSomething,
  probeKey,
  writeExistingAccount
} from './find-key.ts';
import {
  backupTradingKey,
  findTradingKeyWallet,
  SHARED_TRADING_KEY_REFERENCE,
  selectMainWallet,
  signInAgainCommand
} from './oms-key.ts';

type SweepEntry =
  | { address: string; withdrawnUsd: string; txHash: string | null }
  | { address: string; error: string };

export type OwnerStepResult = RecoveryResult & {
  mainWalletError?: string;
  sweptPrevious?: SweepEntry[];
  sweepError?: string;
  restored?: true;
  account?: string;
  existingAccount?: Omit<ExistingAccount, 'at'> & { message: string; command: string };
  chooseAccount?: { accounts: FundedKey[]; message: string; command: string };
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Restores the account the user picked, signing through OMS.
function chooseAccountCommand(wallet: string): string {
  return `polygon-agent polymarket setup --broadcast --from <address>${wallet === 'main' ? '' : ` --wallet ${wallet}`}`;
}

async function backUp(wallet: string, owner: OmsWalletLike, created: boolean) {
  const key = await ensureTradingKey(wallet);
  const res = await backupTradingKey(owner, key, SHARED_TRADING_KEY_REFERENCE);
  writeBackup(wallet, {
    omsWalletId: res.omsWalletId,
    address: res.address,
    at: new Date().toISOString(),
    kind: loadAccount(wallet)?.kind ?? 'deposit-wallet'
  });
  clearExistingAccount(wallet);
  return { backedUp: true, omsWalletId: res.omsWalletId, ...(created ? { created: true } : {}) };
}

async function step(p: {
  wallet: string;
  owner: OmsWalletLike;
  mainAddress: string;
  signsWithOms: boolean;
  attempted: Set<string>;
}): Promise<OwnerStepResult> {
  const { wallet, owner } = p;
  if (hasLocalKey(wallet)) {
    const existing = readBackup(wallet);
    const key = await ensureTradingKey(wallet);
    const address = privateKeyToAccount(key).address.toLowerCase();
    if (existing && existing.address.toLowerCase() === address) {
      return { backedUp: true, omsWalletId: existing.omsWalletId };
    }
    return backUp(wallet, owner, false);
  }
  const recorded = !!loadAccount(wallet) || !!readBackup(wallet);
  let target: Awaited<ReturnType<typeof findAccountKey>>;
  try {
    target = await findAccountKey(wallet, owner);
  } catch (error) {
    // Several accounts hold money (or one couldn't be read): nothing is made or chosen here.
    if (!(error instanceof CliError) || error.code !== 'ambiguous_trading_key') throw error;
    const keys = (error.details?.tradingKeys ?? []) as FundedKey[];
    if (p.signsWithOms) {
      // Signed in: the user picks which account this agent uses.
      clearExistingAccount(wallet);
      return {
        backedUp: false,
        chooseAccount: {
          accounts: keys,
          message: error.message,
          command: chooseAccountCommand(wallet)
        }
      };
    }
    const existing = existingAccounts(keys);
    writeExistingAccount(wallet, existing);
    const { at: _at, ...shown } = existing;
    return {
      backedUp: false,
      existingAccount: {
        ...shown,
        message: existingAccountMessage(existing),
        command: signInAgainCommand(wallet)
      }
    };
  }
  if (target) p.attempted.add(target.address.toLowerCase());
  if (!target) {
    // Local records name a key OMS doesn't hold: it is lost. Never make a key over its account.
    if (recorded) {
      return {
        backedUp: false,
        error: 'trading key missing locally and OMS holds no backup of it; nothing was changed'
      };
    }
    return backUp(wallet, owner, true);
  }
  if (p.signsWithOms) {
    const restored = await restoreFromOms({ wallet, owner, target });
    clearExistingAccount(wallet);
    return {
      backedUp: true,
      omsWalletId: restored.backup.omsWalletId,
      restored: true,
      account: restored.account.wallet
    };
  }
  // This sign-in ends after the request: the key can't sign here afterwards.
  const probe = await probeKey(owner, target);
  if (!holdsSomething(probe) && !recorded) {
    // Nothing to keep: give this install the account to trade with. The newest key under the
    // shared label is the one every install finds next.
    return backUp(wallet, owner, true);
  }
  const existing: ExistingAccount = {
    address: target.address,
    account: probe.account,
    pusd: probe.pusd,
    positions: Array.isArray(probe.positionsLeft) ? probe.positionsLeft.length : null,
    at: new Date().toISOString()
  };
  writeExistingAccount(wallet, existing);
  const { at: _at, ...shown } = existing;
  return {
    backedUp: false,
    existingAccount: {
      ...shown,
      message: existingAccountMessage(existing),
      command: signInAgainCommand(wallet)
    }
  };
}

// Keys this install replaced (recorded in its previous-* folders) can still hold pUSD, e.g.
// a deposit credited after the recovery. Sweeps each funded one to the main wallet, one at a
// time (the OMS signer is not reentrant). Unknown keys and other installs' keys are never
// touched, nor any key this machine still uses under some wallet name.
async function sweepPrevious(
  p: { wallet: string; owner: OmsWalletLike; mainAddress: string },
  exclude: Set<string>
): Promise<SweepEntry[]> {
  const previous = previousTradingKeyAddresses(p.wallet);
  if (previous.length === 0) return [];
  const skip = new Set([...exclude, ...localTradingKeyAddresses()]);
  const out: SweepEntry[] = [];
  for (const address of previous) {
    if (skip.has(address.toLowerCase())) continue;
    try {
      const target = await findTradingKeyWallet(p.owner, { address });
      if (!target) continue;
      const swept = await sweepOldKey({ owner: p.owner, target, mainAddress: p.mainAddress });
      if (swept) out.push({ address: target.address, ...swept });
    } catch (error) {
      out.push({ address, error: message(error) });
    }
  }
  return out;
}

export async function polymarketOwnerStep(p: {
  wallet: string;
  owner: OmsWalletLike;
  mainAddress: string;
  // True when the sign-in stays (owner mode): the account is restored and signed through OMS.
  signsWithOms: boolean;
}): Promise<OwnerStepResult> {
  let result: OwnerStepResult;
  const attempted = new Set<string>();
  try {
    result = await step({ ...p, attempted });
  } catch (error) {
    result = { backedUp: false, error: message(error) };
  }
  try {
    const swept = await sweepPrevious(p, attempted);
    if (swept.length > 0) result = { ...result, sweptPrevious: swept };
  } catch (error) {
    result = { ...result, sweepError: message(error) };
  }
  try {
    await selectMainWallet(p.owner, { expectedAddress: p.mainAddress });
  } catch (error) {
    result = result.backedUp
      ? { ...result, mainWalletError: message(error) }
      : { ...result, error: result.error ?? message(error) };
  }
  return result;
}

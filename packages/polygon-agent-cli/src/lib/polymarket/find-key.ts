// Which backed-up trading key holds this user's Polymarket account, for an install that has no
// key of its own. Read only: listWallets, and for other installs' keys a probe of their account
// through OMS (no builder key, nothing sent).

import fs from 'node:fs';
import path from 'node:path';

import type { OtherKeyRecovery } from './account.ts';
import type { OmsWalletLike } from './oms-key.ts';

import { CliError } from '../errors.ts';
import { readJsonFile, writeJsonFile } from '../session/state.ts';
import {
  accountDir,
  accountFile,
  loadAccount,
  localTradingKeyAddresses,
  readBackup,
  recoverOtherKey
} from './account.ts';
import {
  findTradingKeyWallet,
  installTradingKeyReference,
  listTradingKeyWallets,
  SHARED_TRADING_KEY_REFERENCE
} from './oms-key.ts';

export type KeyTarget = { id: string; address: string };

const sameAddress = (a: string | undefined, b: string | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

// Anything a new account would leave behind: pUSD, open positions, a funded legacy proxy, or
// a read that failed (then the key can't be shown to be empty).
export function holdsSomething(r: OtherKeyRecovery): boolean {
  return (
    Number(r.pusd) > 0 ||
    !!r.legacyProxy ||
    !!r.legacyProxyError ||
    !Array.isArray(r.positionsLeft) ||
    r.positionsLeft.length > 0
  );
}

// Backed-up trading keys this machine doesn't use: other installs', or a lost install's.
export async function untrackedTradingKeys(
  w: OmsWalletLike
): Promise<Array<{ id: string; address: string; reference: string }>> {
  const mine = localTradingKeyAddresses();
  return (await listTradingKeyWallets(w)).filter((x) => !mine.has(x.address.toLowerCase()));
}

// The account a key controls, read through OMS. Never sends anything.
export function probeKey(w: OmsWalletLike, target: KeyTarget): Promise<OtherKeyRecovery> {
  return recoverOtherKey({
    owner: w,
    target,
    mainAddress: w.walletAddress as string,
    broadcast: false
  });
}

// Probes each untracked backed-up key's account, one at a time (the OMS signer is not
// reentrant). One that holds something is the account; several, or one it can't read, need
// the user to pick with --from.
async function fundedOtherKey(w: OmsWalletLike): Promise<KeyTarget | null> {
  const funded: Array<
    { id: string; address: string; reference: string } & Record<string, unknown>
  > = [];
  for (const key of await untrackedTradingKeys(w)) {
    try {
      const r = await probeKey(w, key);
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
        ? `Couldn't read the account of backed-up trading key ${funded[0].address}, so a new one won't be made over it.`
        : `${funded.length} backed-up Polymarket trading keys hold funds or positions.`,
    hint: 'Pick one with: agent polymarket setup --broadcast --from <address>, or make a new account with --new',
    details: {
      tradingKeys: funded.map(({ id: _id, ...rest }) => rest)
    }
  });
}

export type FindOpts = { from?: string; new?: boolean };

// In order: the key the local records name; the one --from names; the shared key every install
// uses; this install's own older label; otherwise the only other backed-up key that holds
// funds or positions. Null means a new key is safe: --new, or no backed-up key holds anything.
export async function findAccountKey(
  wallet: string,
  w: OmsWalletLike,
  opts: FindOpts = {}
): Promise<KeyTarget | null> {
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
  if (opts.new) return null;
  const shared = await findTradingKeyWallet(w, { reference: SHARED_TRADING_KEY_REFERENCE });
  if (shared) return shared;
  const own = await findTradingKeyWallet(w, { reference: installTradingKeyReference() });
  if (own) return own;
  return fundedOtherKey(w);
}

// An account this install found while signed in but can't sign for once the sign-in ends.
// Session-mode `setup` reads it (it can't ask OMS) so it never makes a second account.
export type ExistingAccount = {
  address: string;
  account: string | null;
  pusd: string;
  positions: number | null;
  at: string;
};

const EXISTING_FILE = 'existing.json';

export function readExistingAccount(wallet: string): ExistingAccount | null {
  return (readJsonFile(accountFile(wallet, EXISTING_FILE)) as ExistingAccount | undefined) ?? null;
}

export function writeExistingAccount(wallet: string, existing: ExistingAccount): void {
  writeJsonFile({ file: path.join(accountDir(wallet), EXISTING_FILE), data: existing });
}

export function clearExistingAccount(wallet: string): void {
  fs.rmSync(accountFile(wallet, EXISTING_FILE), { force: true });
}

// What the user is told, in their words: the account exists, and one more sign-in uses it here.
export function existingAccountMessage(existing: Pick<ExistingAccount, 'pusd' | 'positions'>) {
  const parts = [`$${Number(existing.pusd).toFixed(2)}`];
  if (existing.positions) {
    parts.push(`${existing.positions} open position${existing.positions === 1 ? '' : 's'}`);
  }
  return `You already have a Polymarket account with ${parts.join(' and ')}. Sign in once more to use it here.`;
}

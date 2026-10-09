// Best-effort step run while an owner request is confirmed (the CLI is briefly signed in as
// the owner): create the Polymarket trading key if needed and back it up into the user's
// OMS account. It never throws, so it can never fail the owner request it rides on.

import { privateKeyToAccount } from 'viem/accounts';

import type { OmsWalletLike } from './oms-key.ts';

import { ensureTradingKey, hasLocalKey, loadAccount, readBackup, writeBackup } from './account.ts';
import { backupTradingKey, findTradingKeyWallet, selectMainWallet } from './oms-key.ts';

export type OwnerStepResult = {
  backedUp: boolean;
  omsWalletId?: string;
  created?: boolean;
  recovered?: Record<string, unknown>;
  error?: string;
  mainWalletError?: string;
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function backUp(wallet: string, owner: OmsWalletLike, created: boolean) {
  const key = await ensureTradingKey(wallet);
  const res = await backupTradingKey(owner, key);
  writeBackup(wallet, {
    omsWalletId: res.omsWalletId,
    address: res.address,
    at: new Date().toISOString()
  });
  return { backedUp: true, omsWalletId: res.omsWalletId, ...(created ? { created: true } : {}) };
}

// The trading key is gone locally but the account (or an OMS backup) still exists. Task 5
// plugs recovery in here. Never generates or imports a key.
async function recoverMissingKey(found?: {
  id: string;
  address: string;
}): Promise<OwnerStepResult> {
  return {
    backedUp: false,
    ...(found ? { omsWalletId: found.id } : {}),
    error: found
      ? `trading key missing locally; OMS holds a backup (${found.address}) but recovery is not available yet`
      : 'trading key missing; recovery is not available yet'
  };
}

async function step(p: { wallet: string; owner: OmsWalletLike }): Promise<OwnerStepResult> {
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
  if (loadAccount(wallet)) return recoverMissingKey();
  // A wiped machine loses account.json too: if OMS already holds the key, recover, never re-create.
  const found = await findTradingKeyWallet(owner);
  if (found) return recoverMissingKey(found);
  return backUp(wallet, owner, true);
}

export async function polymarketOwnerStep(p: {
  wallet: string;
  owner: OmsWalletLike;
  mainAddress: string;
}): Promise<OwnerStepResult> {
  let result: OwnerStepResult;
  try {
    result = await step(p);
  } catch (error) {
    result = { backedUp: false, error: message(error) };
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

// A deposit whose transfer went out but whose pUSD hasn't been credited yet.
// Recorded so a rerun doesn't send a second deposit.

import fs from 'node:fs';
import path from 'node:path';

import { readJsonFile, writeJsonFile } from '../session/state.ts';
import { accountDir, accountFile } from './account.ts';

export type PendingDeposit = {
  status: 'sending' | 'sent';
  txHash: string | null;
  amountUnits: string;
  bridgeAddress: string;
  sentAt: string;
  // Entries the bridge listed for this address before sending (newest first), so
  // older deposits to the same static address aren't mistaken for this one.
  baselineCount: number;
  // pUSD held before sending.
  pusdBefore: string;
};

const FILE = 'pending-deposit.json';

export function loadPending(wallet: string): PendingDeposit | null {
  return (readJsonFile(accountFile(wallet, FILE)) as PendingDeposit | null) ?? null;
}

export function savePending(wallet: string, d: PendingDeposit): void {
  writeJsonFile({ file: path.join(accountDir(wallet), FILE), data: d });
}

export function clearPending(wallet: string): void {
  fs.rmSync(accountFile(wallet, FILE), { force: true });
}

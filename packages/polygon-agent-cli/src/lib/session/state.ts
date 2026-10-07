// Per-wallet session-mode state under the state folder:
//
//   session/<wallet>/
//     wallet.lock/                 serializes session-key requests and spends
//     rac.key.enc, rac.json        session key (+ rac-next.* during renew)
//     rac.nonce.json, rac-next.nonce.json
//     plan.json                    the approved plan + approvedAt
//     ledger.jsonl                 USD spend ledger
//     transfers/<id>.json          session transfer records

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import type { Plan } from './plan.ts';

import { CliError } from '../errors.ts';
import { LockHeldError, withLock } from '../lock.ts';
import { STORAGE_ROOT } from '../storage.ts';
import { readInstallRecord } from '../workspace.ts';
import { parsePlan, planToJson } from './plan.ts';

// Long enough to wait out another process's spend (prepare, execute, up to a
// minute of status polling).
const WALLET_LOCK_WAIT_MS = 180_000;

export function sessionDir(wallet: string): string {
  const dir = path.join(STORAGE_ROOT, 'session', wallet);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function hasSessionState(wallet: string): boolean {
  return fs.existsSync(path.join(STORAGE_ROOT, 'session', wallet));
}

export function removeSessionState(wallet: string): void {
  fs.rmSync(path.join(STORAGE_ROOT, 'session', wallet), { recursive: true, force: true });
}

// Every session-key request and spend for a wallet runs under this lock: the
// key's request nonces must arrive in order, and spends must not interleave.
export async function withWalletLock<T>(params: {
  wallet: string;
  fn: () => Promise<T>;
}): Promise<T> {
  try {
    return await withLock({
      dir: path.join(sessionDir(params.wallet), 'wallet.lock'),
      fn: params.fn,
      waitMs: WALLET_LOCK_WAIT_MS
    });
  } catch (error) {
    if (error instanceof LockHeldError) {
      throw new CliError({
        code: 'wallet_busy',
        message: `Another polygon-agent command is still using wallet '${params.wallet}'. Try again when it finishes.`,
        cause: error
      });
    }
    throw error;
  }
}

export function writeJsonFile(params: { file: string; data: unknown }): void {
  const tmp = `${params.file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(params.data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, params.file);
}

export function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

// --- plan.json ---

export interface ApprovedPlan {
  plan: Plan;
  approvedAt: string;
}

const ApprovedPlanFile = z.object({ plan: z.unknown(), approvedAt: z.string() });

export function readApprovedPlan(wallet: string): ApprovedPlan | null {
  const parsed = ApprovedPlanFile.safeParse(
    readJsonFile(path.join(sessionDir(wallet), 'plan.json'))
  );
  if (!parsed.success) return null;
  try {
    return { plan: parsePlan(parsed.data.plan), approvedAt: parsed.data.approvedAt };
  } catch {
    return null;
  }
}

export function writeApprovedPlan(params: { wallet: string; approved: ApprovedPlan }): void {
  writeJsonFile({
    file: path.join(sessionDir(params.wallet), 'plan.json'),
    data: { plan: planToJson(params.approved.plan), approvedAt: params.approved.approvedAt }
  });
}

// The name the owner sees for this install: the workspace install's name, else
// the host name.
export function installName(): string {
  return readInstallRecord(STORAGE_ROOT)?.name ?? os.hostname();
}

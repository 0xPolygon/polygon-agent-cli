// Switching to a renewed key takes several steps: retire the old key, promote
// the new one, save the new plan, reset the USD total. A crash part-way would
// leave the install with no live key while the new sessions sit unused, so the
// switch is written down first and finished by whichever command next takes
// the wallet lock (withWalletKeys).

import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import type { OMSWallet } from '@polygonlabs/oms-wallet';

import type { ApprovedPlan } from './state.ts';

import { resetLedger } from './ledger.ts';
import { planToJson, parsePlan } from './plan.ts';
import { promoteNextRac, readRacRecord, retireRac } from './rac.ts';
import { invalidateSessions } from './sessions.ts';
import {
  readJsonFile,
  sessionDir,
  withWalletLock,
  writeApprovedPlan,
  writeJsonFile
} from './state.ts';

const RenewalFile = z.object({ plan: z.unknown(), approvedAt: z.string() });

function renewalFile(wallet: string): string {
  return path.join(sessionDir(wallet), 'renewal.json');
}

// Finishes a recorded switch, if there is one. Each step can run again safely:
// while 'rac-next' exists the promotion hasn't happened, so the live key is
// still the old one. Returns the old key's credential id if OMS hasn't
// confirmed its revoke (it stays parked and is retried), else null.
export async function finishRenewal(params: {
  wallet: string;
  owner?: Pick<OMSWallet['wallet'], 'revokeAccess'>;
}): Promise<string | null> {
  const { wallet } = params;
  const parsed = RenewalFile.safeParse(readJsonFile(renewalFile(wallet)));
  if (!parsed.success) return null;
  let oldPending: string | null = null;
  if (readRacRecord({ wallet, slot: 'rac-next' })) {
    oldPending = await retireRac({ wallet, slot: 'rac', owner: params.owner });
    promoteNextRac(wallet);
  }
  writeApprovedPlan({
    wallet,
    approved: { plan: parsePlan(parsed.data.plan), approvedAt: parsed.data.approvedAt }
  });
  resetLedger(wallet);
  invalidateSessions(wallet);
  fs.rmSync(renewalFile(wallet), { force: true });
  return oldPending;
}

// Records the switch to the renewed key, then makes it.
export async function commitRenewal(params: {
  wallet: string;
  approved: ApprovedPlan;
  owner?: Pick<OMSWallet['wallet'], 'revokeAccess'>;
}): Promise<string | null> {
  writeJsonFile({
    file: renewalFile(params.wallet),
    data: { plan: planToJson(params.approved.plan), approvedAt: params.approved.approvedAt }
  });
  return finishRenewal(params);
}

// The wallet lock for anything that uses the session keys: first finishes a
// renewal a crash interrupted.
export function withWalletKeys<T>(params: { wallet: string; fn: () => Promise<T> }): Promise<T> {
  return withWalletLock({
    wallet: params.wallet,
    fn: async () => {
      await finishRenewal({ wallet: params.wallet });
      return params.fn();
    }
  });
}

// The pending owner request between step 1 (code sent) and step 2 (code
// given): one per wallet, encrypted, deleted once used. It holds the throwaway
// sign-in key, because the SDK signs the email-auth requests with it and step 2
// must use the same key.

import fs from 'node:fs';
import path from 'node:path';

import { getAddress } from 'viem';
import { z } from 'zod';

import type { Plan } from '../session/plan.ts';
import type { EmailAttempt } from './email-attempt.ts';

import { PlanSchema, planToJson } from '../session/plan.ts';
import { readJsonFile, writeJsonFile } from '../session/state.ts';
import { decrypt, encrypt, STORAGE_ROOT } from '../storage.ts';
import { EmailAttemptSchema } from './email-attempt.ts';

export type OwnerAction =
  | { kind: 'connect'; plan: Plan }
  | { kind: 'allowance-set'; plan: Plan }
  | { kind: 'renew'; plan: Plan }
  | {
      kind: 'withdraw';
      chainId: number;
      token: `0x${string}`;
      symbol: string;
      decimals: number;
      to: `0x${string}`;
      amount: bigint;
    }
  | { kind: 'access'; revoke?: { credentialId: string; sessionId?: string } };

export interface PendingRequest {
  id: string;
  wallet: string;
  email: string;
  action: OwnerAction;
  ownerKey: string;
  attempt: EmailAttempt;
  createdAt: string;
  expiresAt: string;
}

const address = z.string().transform((value) => getAddress(value));

const OwnerActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('connect'), plan: PlanSchema }),
  z.object({ kind: z.literal('allowance-set'), plan: PlanSchema }),
  z.object({ kind: z.literal('renew'), plan: PlanSchema }),
  z.object({
    kind: z.literal('withdraw'),
    chainId: z.number(),
    token: address,
    symbol: z.string(),
    decimals: z.number(),
    to: address,
    amount: z.string().transform((value) => BigInt(value))
  }),
  z.object({
    kind: z.literal('access'),
    revoke: z.object({ credentialId: z.string(), sessionId: z.string().optional() }).optional()
  })
]);

const PendingRequestSchema = z.object({
  id: z.string(),
  wallet: z.string(),
  email: z.string(),
  action: OwnerActionSchema,
  ownerKey: z.string(),
  attempt: EmailAttemptSchema,
  createdAt: z.string(),
  expiresAt: z.string()
});

const CipherSchema = z.object({ iv: z.string(), encrypted: z.string(), authTag: z.string() });

function actionToJson(action: OwnerAction): unknown {
  switch (action.kind) {
    case 'connect':
    case 'allowance-set':
    case 'renew':
      return { ...action, plan: planToJson(action.plan) };
    case 'withdraw':
      return { ...action, amount: action.amount.toString() };
    case 'access':
      return action;
  }
}

function pendingFile(wallet: string): string {
  const dir = path.join(STORAGE_ROOT, 'pending');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${wallet}.json`);
}

// Replaces any earlier request for the wallet.
export function savePending(request: PendingRequest): void {
  const plain = JSON.stringify({ ...request, action: actionToJson(request.action) });
  writeJsonFile({ file: pendingFile(request.wallet), data: encrypt(plain) });
}

export function loadPending(wallet: string): PendingRequest | null {
  const cipher = CipherSchema.safeParse(readJsonFile(pendingFile(wallet)));
  if (!cipher.success) return null;
  try {
    const parsed = PendingRequestSchema.safeParse(JSON.parse(decrypt(cipher.data)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function deletePending(wallet: string): void {
  fs.rmSync(pendingFile(wallet), { force: true });
}

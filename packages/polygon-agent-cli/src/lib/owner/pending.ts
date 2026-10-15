// The pending owner request between step 1 (code sent, or browser sign-in
// opened) and step 2 (signed in): one per wallet, encrypted, deleted once used.
// It holds the throwaway sign-in key, because the SDK signs the auth requests
// with it and step 2 must use the same key. A new step 1 replaces the request; step 2 deletes only
// the request it used (under a lock), so it never removes a newer one.

import fs from 'node:fs';
import path from 'node:path';

import { getAddress } from 'viem';
import { z } from 'zod';

import type { Plan } from '../session/plan.ts';
import type { EmailAttempt } from './email-attempt.ts';

import { withLock } from '../lock.ts';
import { PlanSchema, planToJson } from '../session/plan.ts';
import { readJsonFile, writeJsonFile } from '../session/state.ts';
import { decrypt, encrypt, STORAGE_ROOT, walletName } from '../storage.ts';
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
  | { kind: 'access'; revoke?: { credentialId: string; sessionId?: string } }
  // The sign-in is kept as this install's own (no allowance), for what only the
  // owner can sign: a Polymarket account whose key is held in OMS.
  | { kind: 'owner' };

// What the login page is told about the request, so it can say what the
// sign-in approves. Optional on both sides: an older page or relay ignores it.
export interface LoginContext {
  purpose: 'connect' | 'allowance' | 'renew' | 'withdraw' | 'access' | 'owner';
  allowanceUsd?: number;
  days?: number;
  polymarket?: boolean;
}

export interface PendingBase {
  id: string;
  wallet: string;
  action: OwnerAction;
  ownerKey: string;
  createdAt: string;
  expiresAt: string;
}

// `email`: a code was emailed; `attempt` is the SDK's saved code request.
// `browser`: the owner signs in on the login page paired by `relaySession`.
export type PendingRequest = PendingBase &
  (
    | { method: 'email'; email: string; attempt: EmailAttempt }
    | { method: 'browser'; relaySession: string; email?: string }
  );

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
  }),
  z.object({ kind: z.literal('owner') })
]);

const PendingBaseSchema = z.object({
  id: z.string(),
  wallet: z.string(),
  action: OwnerActionSchema,
  ownerKey: z.string(),
  createdAt: z.string(),
  expiresAt: z.string()
});

// Files written before sign-in methods existed have no `method`: they are email.
const PendingRequestSchema = z.preprocess(
  (value) =>
    value && typeof value === 'object' && !('method' in value)
      ? { ...value, method: 'email' }
      : value,
  z.discriminatedUnion('method', [
    PendingBaseSchema.extend({
      method: z.literal('email'),
      email: z.string(),
      attempt: EmailAttemptSchema
    }),
    PendingBaseSchema.extend({
      method: z.literal('browser'),
      relaySession: z.string(),
      email: z.string().optional()
    })
  ])
);

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
    case 'owner':
      return action;
  }
}

function pendingPath(wallet: string): string {
  return path.join(STORAGE_ROOT, 'pending', `${walletName(wallet)}.json`);
}

function pendingFile(wallet: string): string {
  fs.mkdirSync(path.join(STORAGE_ROOT, 'pending'), { recursive: true, mode: 0o700 });
  return pendingPath(wallet);
}

// Replacing and deleting are short, so a few seconds is plenty.
const PENDING_LOCK_WAIT_MS = 10_000;

function withPendingLock<T>(params: { wallet: string; fn: () => T }): Promise<T> {
  return withLock({
    dir: path.join(STORAGE_ROOT, 'pending', `${walletName(params.wallet)}.lock`),
    fn: params.fn,
    waitMs: PENDING_LOCK_WAIT_MS
  });
}

// Replaces any earlier request for the wallet.
export async function savePending(request: PendingRequest): Promise<void> {
  const plain = JSON.stringify({ ...request, action: actionToJson(request.action) });
  await withPendingLock({
    wallet: request.wallet,
    fn: () => writeJsonFile({ file: pendingFile(request.wallet), data: encrypt(plain) })
  });
}

// Reading never creates the folder (`wallet status` runs it on every call).
export function loadPending(wallet: string): PendingRequest | null {
  const file = pendingPath(wallet);
  if (!fs.existsSync(file)) return null;
  const cipher = CipherSchema.safeParse(readJsonFile(file));
  if (!cipher.success) return null;
  try {
    const parsed = PendingRequestSchema.safeParse(JSON.parse(decrypt(cipher.data)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Deletes the request file at once, without the lock: for when the sign-in key
// must leave the disk whatever else is going on.
export function discardPendingNow(wallet: string): void {
  fs.rmSync(pendingFile(wallet), { force: true });
}

// Deletes the wallet's pending request; with `id`, only if it is still that one.
export async function deletePending(params: { wallet: string; id?: string }): Promise<void> {
  await withPendingLock({
    wallet: params.wallet,
    fn: () => {
      if (params.id === undefined || loadPending(params.wallet)?.id === params.id) {
        fs.rmSync(pendingFile(params.wallet), { force: true });
      }
    }
  });
}

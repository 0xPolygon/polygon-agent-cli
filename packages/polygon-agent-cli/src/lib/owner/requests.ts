// Owner requests by email code, in two steps (separate CLI processes):
//
//   1. startOwnerRequest: send the code and save the pending request.
//   2. confirmOwnerRequest: sign in with the code, run the action, and always
//      revoke the sign-in, so nothing owner-level outlives the command.

import { randomBytes, randomInt } from 'node:crypto';

import type { CompleteEmailAuthResult } from '@polygonlabs/oms-wallet';

import {
  EthereumPrivateKeyCredentialSigner,
  MemoryStorageManager,
  OMSWallet,
  isOMSWalletError
} from '@polygonlabs/oms-wallet';

import type { OwnerAction, PendingRequest } from './pending.ts';

import { CliError, mapOmsError, upstreamErrorName } from '../errors.ts';
import { loadOmsConfig } from '../storage.ts';
import { exportEmailAttempt, restoreEmailAttempt } from './email-attempt.ts';
import { deletePending, discardPendingNow, loadPending, savePending } from './pending.ts';

// The owner sign-in's lifetime: as short as OMS allows, so a sign-in whose
// revoke failed dies on its own soon after.
export const OWNER_LOGIN_SECONDS = 600;
export const REQUEST_LIFETIME_MS = 10 * 60 * 1000;

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

// randomInt draws without modulo bias.
function requestId(): string {
  return Array.from({ length: 10 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join('');
}

// A short-lived owner client with an in-memory session and a throwaway key.
export function ownerWallet(ownerKey: Uint8Array): OMSWallet {
  return new OMSWallet({
    publishableKey: loadOmsConfig().publishableKey,
    storage: new MemoryStorageManager(),
    credentialSigner: new EthereumPrivateKeyCredentialSigner(ownerKey)
  });
}

export async function startOwnerRequest(params: {
  wallet: string;
  email: string;
  action: OwnerAction;
  now: Date;
}): Promise<PendingRequest> {
  const ownerKey = randomBytes(32);
  const owner = ownerWallet(ownerKey);
  try {
    await owner.wallet.startEmailAuth({
      email: params.email,
      sessionLifetimeSeconds: OWNER_LOGIN_SECONDS
    });
  } catch (error) {
    throw mapOmsError(error);
  }
  const request: PendingRequest = {
    id: requestId(),
    wallet: params.wallet,
    email: params.email,
    action: params.action,
    ownerKey: ownerKey.toString('hex'),
    attempt: exportEmailAttempt(owner.wallet),
    createdAt: params.now.toISOString(),
    expiresAt: new Date(params.now.getTime() + REQUEST_LIFETIME_MS).toISOString()
  };
  await savePending(request);
  return request;
}

function requestExpired(message: string): CliError {
  return new CliError({
    code: 'request_expired',
    message,
    hint: 'Start the request again; a new code will be sent.'
  });
}

// Signs in with the code. A wrong code (or a rate limit) keeps the request for
// another try. Any other failure deletes it: OMS may have accepted the code
// even if the answer never arrived, and the sign-in key must not stay on disk.
async function signIn(params: {
  request: PendingRequest;
  owner: OMSWallet;
  code: string;
}): Promise<CompleteEmailAuthResult> {
  restoreEmailAttempt({ wallet: params.owner.wallet, attempt: params.request.attempt });
  try {
    return await params.owner.wallet.completeEmailAuth({
      code: params.code.trim(),
      walletSelection: 'automatic'
    });
  } catch (error) {
    const name = upstreamErrorName(error);
    if (name === 'AnswerIncorrect') {
      throw new CliError({
        code: 'invalid_code',
        message: "That code isn't right. Check the latest email and try again.",
        cause: error
      });
    }
    const mapped = mapOmsError(error);
    if (mapped instanceof CliError && mapped.code === 'rate_limited') throw mapped;
    await deletePending({ wallet: params.request.wallet, id: params.request.id });
    if (
      name === 'ChallengeExpired' ||
      name === 'TooManyAttempts' ||
      name === 'CommitmentConsumed' ||
      (isOMSWalletError(error) && error.code === 'OMS_AUTH_COMMITMENT_CONSUMED')
    ) {
      throw requestExpired('The code has expired or was tried too many times.');
    }
    // If OMS did accept the code, that sign-in expires within OWNER_LOGIN_SECONDS.
    throw mapped;
  }
}

export interface OwnerContext {
  owner: OMSWallet;
  walletAddress: string;
  request: PendingRequest;
}

export async function confirmOwnerRequest<T extends Record<string, unknown>>(params: {
  wallet: string;
  requestId: string;
  code: string;
  now: Date;
  run: (context: OwnerContext) => Promise<T>;
}): Promise<T & { ownerSignInRevoked: boolean; ownerSignInRevokeError?: string }> {
  const request = loadPending(params.wallet);
  if (!request || request.id !== params.requestId) {
    throw requestExpired(`No pending request ${params.requestId} for wallet '${params.wallet}'.`);
  }
  if (Date.parse(request.expiresAt) <= params.now.getTime()) {
    await deletePending({ wallet: params.wallet, id: request.id });
    throw requestExpired('The request has expired (requests last 10 minutes).');
  }

  const owner = ownerWallet(Buffer.from(request.ownerKey, 'hex'));
  // Interrupted during the sign-in itself (Ctrl-C, kill): the key may already
  // be an owner credential, so it leaves the disk before exiting. Repeated
  // signals are ignored, so a second Ctrl-C can't cut this short.
  let interrupted = false;
  const onSignalSigningIn = (signal: NodeJS.Signals) => {
    if (interrupted) return;
    interrupted = true;
    discardPendingNow(params.wallet);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', onSignalSigningIn);
  process.on('SIGTERM', onSignalSigningIn);
  let auth: Awaited<ReturnType<typeof signIn>>;
  try {
    auth = await signIn({ request, owner, code: params.code });
  } finally {
    process.removeListener('SIGINT', onSignalSigningIn);
    process.removeListener('SIGTERM', onSignalSigningIn);
  }

  const revokeSignIn = async (): Promise<string | undefined> => {
    try {
      await owner.wallet.revokeAccess({ credentialId: auth.credential.credentialId });
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      await owner.wallet.signOut().catch(() => undefined);
    }
  };
  // Interrupted mid-action (Ctrl-C, kill): still revoke before exiting, and
  // a second signal doesn't cut the revoke short.
  let revoking = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (revoking) return;
    revoking = true;
    void revokeSignIn().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let outcome: { ok: true; result: T } | { ok: false; error: unknown };
  try {
    // Signed in: the key is now an owner credential, so it leaves the disk at
    // once. A newer request saved meanwhile (a new step 1) is left alone,
    // unless the careful delete fails; then the file goes regardless.
    await deletePending({ wallet: params.wallet, id: request.id }).catch(() =>
      discardPendingNow(params.wallet)
    );
    outcome = {
      ok: true,
      result: await params.run({ owner, walletAddress: auth.walletAddress, request })
    };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  // Always: revoke the sign-in and drop the client.
  const revokeError = await revokeSignIn();

  const revoke = {
    ownerSignInRevoked: revokeError === undefined,
    ...(revokeError === undefined ? {} : { ownerSignInRevokeError: revokeError })
  };
  if (!outcome.ok) {
    const mapped = mapOmsError(outcome.error);
    const error =
      mapped instanceof CliError
        ? mapped
        : new CliError({
            code: 'upstream_error',
            message: mapped instanceof Error ? mapped.message : String(mapped),
            cause: mapped
          });
    error.details = { ...error.details, ...revoke };
    throw error;
  }
  return { ...outcome.result, ...revoke };
}

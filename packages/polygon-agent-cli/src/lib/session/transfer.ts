// The session transfer engine: the only code that prepares or executes
// session transactions. Callers hold the wallet lock (withWalletLock).
//
// Every transfer is recorded in transfers/<id>.json before anything is sent,
// moving through preparing → prepared → executed | failed | uncertain. A
// prepared or uncertain transfer is reconciled with OMS before any new one
// starts, and is never resent: if OMS can't say what happened, spending stops.
// An executed transfer counts against the USD allowance from the moment it is
// recorded as executed, whether or not its ledger entry was written yet.

import type { Address } from 'viem';

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { encodeFunctionData, erc20Abi, getAddress } from 'viem';
import { z } from 'zod';

import type { RemoteAccessClient } from '@polygonlabs/oms-wallet';

import { findNetworkById } from '@polygonlabs/oms-wallet';

import type { SpendPurpose } from './ledger.ts';
import type { RacReader } from './sessions.ts';

import { CliError, httpStatus, upstreamErrorName } from '../errors.ts';
import { formatUnits } from '../utils.ts';
import { appendLedger, readLedger, spentUsd } from './ledger.ts';
import { getSessions, invalidateSessions, mapRacError, sessionForToken } from './sessions.ts';
import { readApprovedPlan, readJsonFile, sessionDir, writeJsonFile } from './state.ts';
import { chainLabel, findSupportedToken } from './tokens.ts';

export type RacClient = RacReader &
  Pick<RemoteAccessClient, 'prepareTransaction' | 'executeTransaction' | 'getTransactionStatus'>;

export interface TransferDeps {
  client: RacClient;
  balanceOf: (params: {
    chainId: number;
    token: Address;
    walletAddress: string;
  }) => Promise<bigint>;
  usdPrice: (params: { chainId: number; token: Address }) => Promise<number | undefined>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  // The live session key's credential id; transfers record which key made them.
  credentialId: string;
}

const POLL_MS = 2_000;
const POLL_TIMEOUT_MS = 60_000;
// Without a recorded quote expiry, assume a prepared transaction is dead after this.
const FALLBACK_QUOTE_LIFETIME_MS = 10 * 60 * 1000;
// Slack for the local clock when judging another clock's expiry.
const CLOCK_MARGIN_MS = 2 * 60 * 1000;

const TransferRecordSchema = z.object({
  id: z.string(),
  // abandoned: left unsettled by a session key that has since been replaced, so
  // it can no longer be checked. The on-chain limits applied to it either way.
  state: z.enum(['preparing', 'prepared', 'uncertain', 'executed', 'failed', 'abandoned']),
  chainId: z.number(),
  token: z.string(),
  symbol: z.string(),
  to: z.string(),
  amount: z.string(),
  usd: z.number(),
  purpose: z.enum(['send', 'trade', 'x402']),
  ref: z.string().optional(),
  walletId: z.string(),
  sessionId: z.string(),
  credentialId: z.string().optional(),
  txnId: z.string().optional(),
  executedAt: z.string().optional(),
  // When the prepared transaction stops being executable.
  quoteExpiresAt: z.string().optional(),
  txHash: z.string().optional(),
  error: z.string().optional(),
  // Set only when it's certain no tokens moved (never prepared or executed,
  // OMS has no record of it, it reverted, or its quote expired unexecuted). A
  // failure without it may still have gone through.
  neverSent: z.boolean().optional(),
  // Set just before executeTransaction is called.
  executeAttempted: z.boolean().optional(),
  ledgered: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type TransferRecord = z.infer<typeof TransferRecordSchema>;

function transfersDir(wallet: string): string {
  const dir = path.join(sessionDir(wallet), 'transfers');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function saveRecord(params: { wallet: string; record: TransferRecord }): void {
  writeJsonFile({
    file: path.join(transfersDir(params.wallet), `${params.record.id}.json`),
    data: params.record
  });
}

export function listTransfers(wallet: string): TransferRecord[] {
  const dir = transfersDir(wallet);
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => TransferRecordSchema.safeParse(readJsonFile(path.join(dir, name))))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function update(params: {
  wallet: string;
  record: TransferRecord;
  deps: TransferDeps;
  patch: Partial<TransferRecord>;
}): TransferRecord {
  const record = { ...params.record, ...params.patch, updatedAt: params.deps.now().toISOString() };
  saveRecord({ wallet: params.wallet, record });
  return record;
}

function executedAt(record: TransferRecord): string {
  return record.executedAt ?? record.updatedAt;
}

// Writes an executed transfer's ledger entry, once: if a crash came between
// the append and marking the record, the entry is found and not added again.
// The record is marked only once the entry reads back.
function recordLedger(params: {
  wallet: string;
  record: TransferRecord;
  deps: TransferDeps;
}): TransferRecord {
  const { wallet, record } = params;
  const inLedger = () => readLedger(wallet).some((entry) => entry.transferId === record.id);
  if (record.ledgered && inLedger()) return record;
  if (!inLedger()) {
    appendLedger({
      wallet,
      entry: {
        ts: executedAt(record),
        chainId: record.chainId,
        token: record.token,
        symbol: record.symbol,
        amount: record.amount,
        usd: record.usd,
        purpose: record.purpose,
        ref: record.txHash ?? record.ref,
        transferId: record.id
      }
    });
  }
  if (!inLedger()) {
    throw new Error(`The spend ledger entry for transfer ${record.id} didn't read back`);
  }
  return update({ ...params, patch: { ledgered: true } });
}

// USD spent since `since`: the ledger, plus every executed transfer without a
// readable ledger entry (whatever its `ledgered` flag says).
export function spentUsdSince(params: { wallet: string; since: string }): number {
  const inLedger = new Set(readLedger(params.wallet).map((entry) => entry.transferId));
  const since = Date.parse(params.since);
  const unledgered = listTransfers(params.wallet)
    .filter(
      (record) =>
        record.state === 'executed' &&
        !inLedger.has(record.id) &&
        Date.parse(executedAt(record)) >= since
    )
    .reduce((sum, record) => sum + record.usd, 0);
  return Math.round((spentUsd(params) + unledgered) * 100) / 100;
}

// Polls OMS until the transaction is executed or failed, for up to a minute.
async function settle(params: {
  wallet: string;
  record: TransferRecord;
  deps: TransferDeps;
}): Promise<TransferRecord> {
  const { record, deps } = params;
  if (!record.txnId) return record;
  const deadline = deps.now().getTime() + POLL_TIMEOUT_MS;
  for (;;) {
    let status: Awaited<ReturnType<RacClient['getTransactionStatus']>> | undefined;
    try {
      status = await deps.client.getTransactionStatus({ txnId: record.txnId });
    } catch (error) {
      if (httpStatus(error) === 401) throw mapRacError({ error, wallet: params.wallet });
      if (httpStatus(error) === 404) {
        return update({
          ...params,
          // Proof nothing ran only if it was never executed; after an execute
          // a 404 is an anomaly, so it stays open.
          patch: record.executeAttempted
            ? { state: 'uncertain' }
            : {
                state: 'failed',
                neverSent: true,
                error: 'OMS has no record of this transaction; it never ran'
              }
        });
      }
    }
    if (status?.status === 'executed' && status.txnHash) {
      const executed = update({
        ...params,
        patch: { state: 'executed', txHash: status.txnHash, executedAt: deps.now().toISOString() }
      });
      try {
        return recordLedger({ ...params, record: executed });
      } catch {
        // The transfer went through; it still counts (spentUsdSince), and the
        // entry is written before the next transfer starts.
        return executed;
      }
    }
    if (status?.status === 'failed') {
      return update({
        ...params,
        patch: { state: 'failed', neverSent: true, error: 'OMS reported the transaction failed' }
      });
    }
    // Still only quoted: it was never executed, but an execute already sent
    // could still land until the quote expires. Only after that is it dead.
    const quoteExpiry = record.quoteExpiresAt
      ? Date.parse(record.quoteExpiresAt)
      : Date.parse(record.createdAt) + FALLBACK_QUOTE_LIFETIME_MS;
    if (status?.status === 'quoted' && deps.now().getTime() > quoteExpiry + CLOCK_MARGIN_MS) {
      return update({
        ...params,
        patch: {
          state: 'failed',
          neverSent: true,
          error: 'prepared but never executed (quote expired)'
        }
      });
    }
    if (deps.now().getTime() >= deadline) {
      return update({ ...params, patch: { state: 'uncertain' } });
    }
    await deps.sleep(POLL_MS);
  }
}

// Settles any transfer left prepared or uncertain, and writes any missing
// ledger entry. Throws upstream_unavailable if a transfer still can't be
// settled: no new transfer starts until it is.
export async function reconcileTransfers(params: {
  wallet: string;
  deps: TransferDeps;
}): Promise<void> {
  // Entries are written only for this allowance period: earlier ones were
  // reset on purpose when the allowance changed.
  const approvedAt = readApprovedPlan(params.wallet)?.approvedAt;
  const inLedger = new Set(readLedger(params.wallet).map((entry) => entry.transferId));
  for (const record of listTransfers(params.wallet)) {
    if (record.state === 'executed') {
      if (
        approvedAt !== undefined &&
        !inLedger.has(record.id) &&
        Date.parse(executedAt(record)) >= Date.parse(approvedAt)
      ) {
        recordLedger({ ...params, record });
      }
      continue;
    }
    const open =
      record.state === 'preparing' || record.state === 'prepared' || record.state === 'uncertain';
    if (open && record.credentialId && record.credentialId !== params.deps.credentialId) {
      update({
        ...params,
        record,
        patch: {
          state: 'abandoned',
          error: 'the session key that made it was replaced before it settled'
        }
      });
      continue;
    }
    if (record.state === 'preparing') {
      // Crashed before a txnId was saved, so it was never executed.
      update({
        ...params,
        record,
        patch: { state: 'failed', neverSent: true, error: 'interrupted before preparing' }
      });
      continue;
    }
    if (record.state !== 'prepared' && record.state !== 'uncertain') continue;
    const settled = await settle({ ...params, record });
    if (settled.state === 'uncertain') {
      throw new CliError({
        code: 'upstream_unavailable',
        message: `A previous transfer (${settled.amount} ${settled.symbol} on ${chainLabel(settled.chainId)}, OMS transaction ${settled.txnId}) hasn't settled yet, so no new transfer will start. Try again in a minute.`,
        details: { pendingTransfer: settled.id, txnId: settled.txnId }
      });
    }
  }
}

function mapPrepareOrExecuteError(error: unknown): CliError | null {
  const name = upstreamErrorName(error);
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'UsageLimitExceeded') {
    return new CliError({
      code: 'allowance_exhausted',
      message: 'The on-chain limit for this token is used up.',
      command: 'polygon-agent wallet allowance set',
      cause: error
    });
  }
  if (/sponsor/i.test(message)) {
    return new CliError({
      code: 'not_sponsored',
      message:
        "OMS won't sponsor gas for this session transfer, and sessions can't pay their own gas.",
      cause: error
    });
  }
  return null;
}

// Rounded up to the cent, so even dust counts against the allowance.
function usdFor(params: { amount: bigint; decimals: number; priceUsd: number }): number {
  const usd = Number(formatUnits(params.amount, params.decimals)) * params.priceUsd;
  return Math.ceil(Math.round(usd * 1e6) / 1e4) / 100;
}

export interface SessionTransferResult {
  txHash: string;
  txnId: string;
  transferId: string;
  usd: number;
}

// Transfers `amount` of `token` to `to` through the chain's session.
export async function sessionTransfer(params: {
  wallet: string;
  walletAddress: string;
  chainId: number;
  token: Address;
  to: Address;
  amount: bigint;
  purpose: SpendPurpose;
  ref?: string;
  // Don't send after this time (ms), e.g. a trade quote's expiry; checked once
  // the lock is held and earlier transfers are settled.
  notAfter?: number;
  deps: TransferDeps;
}): Promise<SessionTransferResult> {
  const { wallet, deps } = params;
  const network = findNetworkById(params.chainId);
  if (!network) {
    throw new CliError({
      code: 'not_covered',
      message: `Chain ${params.chainId} isn't supported.`
    });
  }
  if (params.amount <= 0n) {
    throw new CliError({ code: 'invalid_input', message: 'The amount must be greater than zero.' });
  }

  await reconcileTransfers({ wallet, deps });

  const check = await checkTransfer(params);
  if (params.notAfter !== undefined && deps.now().getTime() > params.notAfter) {
    throw new CliError({
      code: 'quote_expired',
      message: 'The quote expired while waiting to send; nothing was sent.',
      hint: 'Quote again.'
    });
  }

  const now = deps.now().toISOString();
  let record: TransferRecord = {
    id: `${Date.now()}-${randomBytes(4).toString('hex')}`,
    state: 'preparing',
    chainId: params.chainId,
    token: params.token,
    symbol: check.symbol,
    to: params.to,
    amount: params.amount.toString(),
    usd: check.usd,
    purpose: params.purpose,
    ref: params.ref,
    walletId: check.walletId,
    sessionId: check.sessionId,
    credentialId: deps.credentialId,
    ledgered: false,
    createdAt: now,
    updatedAt: now
  };
  saveRecord({ wallet, record });

  let prepared: Awaited<ReturnType<RacClient['prepareTransaction']>>;
  try {
    prepared = await deps.client.prepareTransaction({
      walletId: check.walletId,
      sessionId: check.sessionId,
      network,
      to: params.token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [params.to, params.amount]
      })
    });
  } catch (error) {
    update({
      wallet,
      record,
      deps,
      patch: { state: 'failed', neverSent: true, error: String(error) }
    });
    throw mapPrepareOrExecuteError(error) ?? mapRacError({ error, wallet });
  }
  if (!prepared.sponsored) {
    update({
      wallet,
      record,
      deps,
      patch: { state: 'failed', neverSent: true, error: 'not sponsored' }
    });
    throw new CliError({
      code: 'not_sponsored',
      message: `OMS won't sponsor gas for session transfers on ${chainLabel(params.chainId)}, and sessions can't pay their own gas.`
    });
  }
  // Saved before executing, so a crash from here on is reconciled, never resent.
  record = update({
    wallet,
    record,
    deps,
    patch: {
      state: 'prepared',
      txnId: prepared.txnId,
      ...(prepared.expiresAt ? { quoteExpiresAt: prepared.expiresAt } : {})
    }
  });

  try {
    record = update({ wallet, record, deps, patch: { executeAttempted: true } });
    await deps.client.executeTransaction({ txnId: prepared.txnId });
  } catch (error) {
    const status = httpStatus(error);
    if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      update({ wallet, record, deps, patch: { state: 'failed', error: String(error) } });
      invalidateSessions(wallet);
      throw mapPrepareOrExecuteError(error) ?? mapRacError({ error, wallet });
    }
    // A timeout, network error or 5xx: it may or may not have gone through.
    record = update({ wallet, record, deps, patch: { state: 'uncertain' } });
  }

  record = await settle({ wallet, record, deps });
  invalidateSessions(wallet);
  if (record.state === 'executed' && record.txHash) {
    return { txHash: record.txHash, txnId: prepared.txnId, transferId: record.id, usd: record.usd };
  }
  if (record.state === 'failed') {
    throw new CliError({
      code: 'upstream_error',
      message: `The transfer failed on ${chainLabel(params.chainId)} (OMS transaction ${prepared.txnId}).`,
      details: { txnId: prepared.txnId }
    });
  }
  throw new CliError({
    code: 'upstream_unavailable',
    message: `OMS hasn't confirmed the transfer yet (transaction ${prepared.txnId}). It won't be resent; the next command checks it first.`,
    details: { txnId: prepared.txnId }
  });
}

export interface TransferCheck {
  symbol: string;
  decimals: number;
  usd: number;
  sessionId: string;
  walletId: string;
  remaining: bigint | null;
  allowanceUsd: number;
  spentUsd: number;
}

// The checks before a session transfer, also used for dry runs.
export async function checkTransfer(params: {
  wallet: string;
  walletAddress: string;
  chainId: number;
  token: Address;
  amount: bigint;
  deps: TransferDeps;
}): Promise<TransferCheck> {
  const { wallet, deps } = params;
  const approved = readApprovedPlan(wallet);
  if (!approved) {
    // Without the plan there's no USD total to check against; don't spend blind.
    throw new CliError({
      code: 'not_connected',
      message: "This install's approved allowance is missing, so it can't check what it may spend.",
      hint: 'Connect again with a new email code.',
      command: 'polygon-agent wallet login --email <email>'
    });
  }
  const sessions = await getSessions({
    wallet,
    client: deps.client,
    fresh: true,
    chainId: params.chainId
  });
  const found = sessionForToken({ sessions, chainId: params.chainId, token: params.token });
  const planGrant = approved.plan.chains
    .find((chain) => chain.chainId === params.chainId)
    ?.grants.find((grant) => grant.token.toLowerCase() === params.token.toLowerCase());
  const known = findSupportedToken({ chainId: params.chainId, address: params.token });
  const symbol = planGrant?.symbol ?? known?.symbol ?? params.token;
  const decimals = planGrant?.decimals ?? known?.decimals;

  if (!found) {
    const live = sessions.filter((session) => !session.expired);
    if (sessions.length > 0 && live.length === 0) {
      throw new CliError({
        code: 'session_expired',
        message: `The allowance on ${chainLabel(params.chainId)} has expired.`,
        command: 'polygon-agent wallet allowance renew'
      });
    }
    throw new CliError({
      code: 'not_covered',
      message: `${symbol} on ${chainLabel(params.chainId)} isn't covered by the allowance.`,
      command: `polygon-agent wallet allowance set --add ${symbol}@${findNetworkById(params.chainId)?.name ?? params.chainId}`
    });
  }
  if (decimals === undefined) {
    throw new CliError({
      code: 'not_covered',
      message: `Token ${params.token} on ${chainLabel(params.chainId)} isn't in the approved plan.`
    });
  }

  const display = `${formatUnits(params.amount, decimals)} ${symbol}`;
  if (found.grant.remaining !== null && params.amount > found.grant.remaining) {
    throw new CliError({
      code: 'allowance_exhausted',
      message: `${display} is more than the ${formatUnits(found.grant.remaining, decimals)} ${symbol} left on ${chainLabel(params.chainId)}.`,
      command: 'polygon-agent wallet allowance set'
    });
  }

  // Valued at the current price only: the price at approval time could be
  // weeks old and understate what is spent.
  const priceUsd =
    known?.kind === 'usd' || planGrant?.kind === 'usd'
      ? 1
      : await deps.usdPrice({ chainId: params.chainId, token: params.token });
  if (priceUsd === undefined || !Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new CliError({
      code: 'upstream_unavailable',
      message: `No current USD price for ${symbol}, so the allowance total can't be checked. Try again shortly.`
    });
  }
  const usd = usdFor({ amount: params.amount, decimals, priceUsd });
  const allowanceUsd = approved.plan.allowanceUsd;
  const spent = spentUsdSince({ wallet, since: approved.approvedAt });
  if (spent + usd > allowanceUsd) {
    throw new CliError({
      code: 'allowance_exhausted',
      message: `${display} (~$${usd}) would take the total spent to $${(spent + usd).toFixed(2)}, past the $${allowanceUsd} allowance.`,
      command: 'polygon-agent wallet allowance set'
    });
  }

  const balance = await deps.balanceOf({
    chainId: params.chainId,
    token: getAddress(params.token),
    walletAddress: params.walletAddress
  });
  if (balance < params.amount) {
    throw new CliError({
      code: 'insufficient_balance',
      message: `The wallet holds ${formatUnits(balance, decimals)} ${symbol} on ${chainLabel(params.chainId)}, less than ${display}.`
    });
  }

  return {
    symbol,
    decimals,
    usd,
    sessionId: found.session.sessionId,
    walletId: found.session.walletId,
    remaining: found.grant.remaining,
    allowanceUsd,
    spentUsd: spent
  };
}

// After a chain's session is approved: can it get sponsored gas? Prepares a
// zero-amount transfer to the wallet itself and never executes it (an
// unexecuted prepared transaction just expires).
export async function probeSponsorship(params: {
  client: Pick<RemoteAccessClient, 'prepareTransaction'>;
  walletId: string;
  sessionId: string;
  chainId: number;
  token: Address;
  walletAddress: string;
}): Promise<{ sponsored: boolean | null; error?: string }> {
  // null: the probe itself failed for another reason, so sponsorship is unknown.
  const network = findNetworkById(params.chainId);
  if (!network) return { sponsored: false, error: 'unsupported chain' };
  try {
    const prepared = await params.client.prepareTransaction({
      walletId: params.walletId,
      sessionId: params.sessionId,
      network,
      to: params.token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [getAddress(params.walletAddress), 0n]
      })
    });
    return prepared.sponsored ? { sponsored: true } : { sponsored: false, error: 'not sponsored' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { sponsored: /sponsor/i.test(message) ? false : null, error: message };
  }
}

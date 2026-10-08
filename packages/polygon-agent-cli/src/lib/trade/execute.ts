// Executing a quoted swap, resumable at every step (shared by `swap`,
// `swap status` and watches):
//
//   1. quoted → depositing: saved before the deposit is sent, then the deposit
//      goes through runTx (purpose 'trade', ref = intent id). A deposit is never
//      sent twice: in session mode the transfer engine's records for this intent
//      (reconciled with OMS first) say whether it went out, and only a record
//      that certainly moved nothing reopens the quote; in owner mode an unclear
//      failure is reported, not retried.
//   2. depositing → executing: wait until the deposit is mined (Trails marks an
//      intent INVALID if given a hash it can't find), then executeIntent,
//      unless Trails already has it running.
//   3. executing → completed | refunded | failed, or still executing at the
//      timeout (resume with `swap status`).

import path from 'node:path';

import { isHex } from 'viem';

import type { TradeRecord } from './state.ts';

import { CliError, NOTHING_SENT_CODES } from '../errors.ts';
import { LockHeldError, withLock } from '../lock.ts';
import { trailsClient } from '../prices.ts';
import { liveTransferDeps } from '../session/live.ts';
import { withWalletKeys } from '../session/renewal.ts';
import { listTransfers, reconcileTransfers } from '../session/transfer.ts';
import { loadOmsWalletPointer, STORAGE_ROOT } from '../storage.ts';
import { runTx } from '../tx-dispatch.ts';
import { getReadRpcUrl, resolveNetwork } from '../utils.ts';
import { loadTrade, updateTrade } from './state.ts';
import { validateSavedDeposit } from './validate.ts';

const RECEIPT_TIMEOUT_MS = 60_000;
const EXECUTE_RETRY_MS = 3_000;
const EXECUTE_TIMEOUT_MS = 120_000;
const POLL_MS = 3_000;

export const DEFAULT_TRADE_TIMEOUT_MS = 120_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type DepositOutcome = { sent: true; txHash: string } | { sent: false } | { sent: 'unknown' };

// Whether this trade's deposit went out. Only session mode can tell, from the
// transfer engine's records, settled with OMS first. Nothing was sent only if
// there is no record (stopped before preparing) or every record certainly
// moved nothing; an abandoned or otherwise failed transfer may have gone out.
async function depositOutcome(trade: TradeRecord): Promise<DepositOutcome> {
  if (trade.mode !== 'session') return { sent: 'unknown' };
  const wallet = trade.walletName;
  const settled = await withWalletKeys({
    wallet,
    fn: () => reconcileTransfers({ wallet, deps: liveTransferDeps(wallet) })
  })
    .then(() => true)
    .catch(() => false);
  const records = listTransfers(wallet).filter((r) => r.ref === trade.intentId);
  const executed = records.find((r) => r.state === 'executed' && r.txHash);
  if (executed?.txHash) return { sent: true, txHash: executed.txHash };
  if (settled && records.every((r) => r.state === 'failed' && r.neverSent === true)) {
    return { sent: false };
  }
  return { sent: 'unknown' };
}

// The trade runs only from the wallet and mode it was quoted for: the deposit
// was checked against that address, and only session mode can tell whether a
// deposit went out.
async function requireSameWallet(trade: TradeRecord): Promise<void> {
  const pointer = await loadOmsWalletPointer(trade.walletName);
  const mode = pointer?.access === 'session' ? 'session' : 'owner';
  if (
    !pointer ||
    pointer.walletAddress.toLowerCase() !== trade.walletAddress.toLowerCase() ||
    mode !== trade.mode
  ) {
    throw new CliError({
      code: 'invalid_input',
      message: `Wallet '${trade.walletName}' is no longer the ${trade.mode}-mode wallet ${trade.walletAddress} this trade was quoted for, so it won't be sent.`,
      hint: 'Quote again.'
    });
  }
}

async function sendDeposit(params: {
  trade: TradeRecord;
  notAfter?: number;
}): Promise<TradeRecord> {
  const { trade } = params;
  // The quote's expiry, or the caller's earlier deadline (a watch's).
  const deadline = Math.min(Date.parse(trade.expiresAt), params.notAfter ?? Infinity);
  if (Date.now() > deadline) {
    throw new CliError({
      code: 'quote_expired',
      message:
        deadline < Date.parse(trade.expiresAt)
          ? `The deadline for intent ${trade.intentId} passed at ${new Date(deadline).toISOString()}; nothing was sent.`
          : `The quote for intent ${trade.intentId} expired at ${trade.expiresAt}; nothing was sent.`,
      hint: 'Quote again.'
    });
  }
  await requireSameWallet(trade);
  validateSavedDeposit(trade);
  let current = updateTrade({ record: trade, patch: { state: 'depositing' }, now: new Date() });
  try {
    const result = await runTx({
      walletName: trade.walletName,
      chainId: trade.origin.chainId,
      transactions: [
        { to: trade.deposit.to, data: trade.deposit.data, value: BigInt(trade.deposit.value) }
      ],
      broadcast: true,
      preferNativeFee: false,
      purpose: 'trade',
      ref: trade.intentId,
      // Re-checked once the wallet lock is held: never deposit after expiry.
      notAfter: deadline
    });
    if (!result.txHash) throw new Error('the deposit returned no transaction hash');
    return updateTrade({
      record: current,
      patch: { depositTxHash: result.txHash, error: undefined },
      now: new Date()
    });
  } catch (error) {
    // A refusal raised before any transfer for this trade was recorded (a
    // check, a busy lock): nothing went out. Once a record exists, the same
    // codes can come from polling after execute (e.g. session_revoked), so
    // only the reconciled records decide.
    const refusedBeforeSending =
      error instanceof CliError &&
      NOTHING_SENT_CODES.has(error.code) &&
      (current.mode !== 'session' ||
        !listTransfers(current.walletName).some((r) => r.ref === current.intentId));
    const outcome: DepositOutcome = refusedBeforeSending
      ? { sent: false }
      : await depositOutcome(current);
    if (outcome.sent === true) {
      return updateTrade({
        record: current,
        patch: { depositTxHash: outcome.txHash },
        now: new Date()
      });
    }
    // Nothing went out: the quote can be tried again until it expires.
    current = updateTrade({
      record: current,
      patch:
        outcome.sent === false
          ? { state: 'quoted', error: message(error) }
          : { error: message(error) },
      now: new Date()
    });
    throw error;
  }
}

async function waitForDeposit(params: {
  trade: TradeRecord;
  txHash: string;
}): Promise<'success' | 'reverted'> {
  const { trade, txHash } = params;
  if (!isHex(txHash)) throw new Error(`Not a transaction hash: ${txHash}`);
  const { createPublicClient, http } = await import('viem');
  const chains = await import('viem/chains');
  const chain = Object.values(chains).find((c) => c.id === trade.origin.chainId);
  if (!chain) throw new Error(`No RPC configuration for chain ${trade.origin.chainId}`);
  const client = createPublicClient({
    chain,
    transport: http(
      process.env.SEQUENCE_PROJECT_ACCESS_KEY
        ? getReadRpcUrl(resolveNetwork(trade.origin.chainId))
        : chain.rpcUrls.default.http[0]
    )
  });
  try {
    const receipt = await client.waitForTransactionReceipt({
      hash: txHash,
      timeout: RECEIPT_TIMEOUT_MS
    });
    if (receipt.transactionHash.toLowerCase() !== txHash.toLowerCase()) {
      throw new Error(`the deposit was replaced by ${receipt.transactionHash}`);
    }
    return receipt.status === 'success' ? 'success' : 'reverted';
  } catch (error) {
    throw new CliError({
      code: 'upstream_unavailable',
      message: `The deposit ${txHash} for intent ${trade.intentId} isn't confirmed yet (${message(error)}). It won't be sent again.`,
      command: `polygon-agent swap status --intent ${trade.intentId}`,
      cause: error
    });
  }
}

async function startIntent(initial: TradeRecord): Promise<TradeRecord> {
  let trade = initial;
  let txHash = trade.depositTxHash;
  if (!txHash) {
    const outcome = await depositOutcome(trade);
    if (outcome.sent === false) {
      // Interrupted before anything went out.
      return updateTrade({ record: trade, patch: { state: 'quoted' }, now: new Date() });
    }
    if (outcome.sent === 'unknown') {
      throw trade.mode === 'session'
        ? new CliError({
            code: 'upstream_unavailable',
            message: `The deposit for intent ${trade.intentId} hasn't settled, or can't be confirmed (e.g. its session key was replaced). It won't be sent again; if this persists, check the wallet's activity.`,
            command: `polygon-agent swap status --intent ${trade.intentId}`
          })
        : new CliError({
            code: 'upstream_error',
            message: `It's unclear whether the deposit for intent ${trade.intentId} was sent (${trade.error ?? 'interrupted'}). It won't be sent again; check the wallet's activity before trading again.`
          });
    }
    txHash = outcome.txHash;
    trade = updateTrade({ record: trade, patch: { depositTxHash: txHash }, now: new Date() });
  }

  if ((await waitForDeposit({ trade, txHash })) === 'reverted') {
    return updateTrade({
      record: trade,
      patch: { state: 'failed', error: `The deposit ${txHash} reverted; nothing was traded.` },
      now: new Date()
    });
  }

  const { UnavailableError } = await import('@0xtrails/api');
  const trails = await trailsClient();
  // An earlier run may have executed it already.
  const known = await trails
    .getIntentReceipt({ intentId: trade.intentId })
    .then((res) => res.intentReceipt?.status)
    .catch(() => undefined);
  if (known && known !== 'QUOTED' && known !== 'COMMITTED') {
    return updateTrade({
      record: trade,
      patch: { state: 'executing', intentStatus: known },
      now: new Date()
    });
  }

  const start = Date.now();
  for (;;) {
    try {
      const res = await trails.executeIntent({
        intentId: trade.intentId,
        depositTransactionHash: txHash
      });
      return updateTrade({
        record: trade,
        patch: { state: 'executing', intentStatus: res.intentStatus },
        now: new Date()
      });
    } catch (error) {
      const transient = error instanceof UnavailableError;
      if (transient && Date.now() - start < EXECUTE_TIMEOUT_MS) {
        await sleep(EXECUTE_RETRY_MS);
        continue;
      }
      // Refused for good: settle the trade from Trails' own view if it has one.
      const status = await trails
        .getIntentReceipt({ intentId: trade.intentId })
        .then((res) => res.intentReceipt?.status)
        .catch(() => undefined);
      if (status && status !== 'QUOTED' && status !== 'COMMITTED') {
        return updateTrade({
          record: trade,
          patch: { state: 'executing', intentStatus: status },
          now: new Date()
        });
      }
      throw new CliError({
        code: transient ? 'upstream_unavailable' : 'upstream_error',
        message: `Trails didn't take intent ${trade.intentId} after deposit ${txHash} (${message(error)}). The deposit won't be sent again.${transient ? ' Retry to execute it.' : ' Check it later with swap status, and give the intent id to Trails support if it stays stuck.'}`,
        command: `polygon-agent swap status --intent ${trade.intentId}`,
        cause: error
      });
    }
  }
}

async function waitForIntent(params: {
  trade: TradeRecord;
  timeoutMs: number;
}): Promise<TradeRecord> {
  let { trade } = params;
  const trails = await trailsClient();
  const deadline = Date.now() + params.timeoutMs;
  for (;;) {
    const res = await trails.waitIntentReceipt({ intentId: trade.intentId });
    const receipt = res?.intentReceipt;
    const status = receipt?.status;
    if (res?.done && receipt) {
      if (status === 'SUCCEEDED') {
        const received = receivedAmount(receipt.summary?.destinationTokenAmount);
        return updateTrade({
          record: trade,
          patch: {
            state: 'completed',
            intentStatus: status,
            destinationTxHash:
              receipt.destinationTransaction?.txnHash ?? receipt.originTransaction?.txnHash,
            // Trails can leave the amount out (null) of a succeeded receipt.
            ...(received !== undefined ? { receivedAmount: received } : {})
          },
          now: new Date()
        });
      }
      return updateTrade({
        record: trade,
        patch: {
          state: status === 'REFUNDED' ? 'refunded' : 'failed',
          intentStatus: status,
          ...(receipt.refundTransaction?.txnHash
            ? { refundTxHash: receipt.refundTransaction.txnHash }
            : {}),
          error: `Trails reported ${status ?? 'a failure'}`
        },
        now: new Date()
      });
    }
    if (status && status !== trade.intentStatus) {
      trade = updateTrade({ record: trade, patch: { intentStatus: status }, now: new Date() });
    }
    if (Date.now() >= deadline) return trade;
    await sleep(POLL_MS);
  }
}

function receivedAmount(value: unknown): string | undefined {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  return undefined;
}

// Moves the trade as far as it can go. Returns it in its latest state
// (`executing` if Trails is still working at the timeout). One process at a
// time per trade: two could otherwise both conclude a deposit never went out.
export async function executeSwap(params: {
  trade: TradeRecord;
  timeoutMs?: number;
  // false: never send a deposit (swap status resumes, it doesn't start).
  send?: boolean;
  // No deposit after this (ms), even if the quote is still valid.
  notAfter?: number;
}): Promise<TradeRecord> {
  try {
    return await withLock({
      dir: path.join(STORAGE_ROOT, 'locks', 'trades', `${params.trade.intentId}.lock`),
      fn: async () => {
        // Re-read under the lock: another process may have moved it on.
        let trade = loadTrade(params.trade.intentId) ?? params.trade;
        if (trade.state === 'quoted') {
          if (params.send === false) return trade;
          trade = await sendDeposit({ trade, notAfter: params.notAfter });
        }
        if (trade.state === 'depositing') trade = await startIntent(trade);
        // An interrupted run found nothing went out: send it now (still under
        // the trade lock), unless this is only a status check.
        if (trade.state === 'quoted' && params.send !== false) {
          trade = await sendDeposit({ trade, notAfter: params.notAfter });
          if (trade.state === 'depositing') trade = await startIntent(trade);
        }
        if (trade.state === 'executing') {
          trade = await waitForIntent({
            trade,
            timeoutMs: params.timeoutMs ?? DEFAULT_TRADE_TIMEOUT_MS
          });
        }
        return trade;
      }
    });
  } catch (error) {
    if (error instanceof LockHeldError) {
      throw new CliError({
        code: 'wallet_busy',
        message: `Another polygon-agent command is working on intent ${params.trade.intentId}. Check it with swap status when it finishes.`,
        command: `polygon-agent swap status --intent ${params.trade.intentId}`,
        cause: error
      });
    }
    throw error;
  }
}

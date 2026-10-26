// The transfer engine: the only code that prepares or executes a connection's
// transactions. A port of the CLI's session engine (session/transfer.ts and
// sessions.ts) onto a store the connection's Durable Object provides, which
// also runs one call at a time.
//
// Every transfer is recorded before anything is sent, moving through
// preparing → prepared → executed | failed | uncertain. A prepared or uncertain
// transfer is settled with OMS before any new one starts, and is never resent:
// if OMS can't say what happened, spending stops. An executed transfer counts
// against the USD allowance from the moment it is recorded as executed.

import type { Address } from 'viem';

import { encodeFunctionData, erc20Abi, formatUnits, getAddress } from 'viem';

import type { RemoteAccessClient } from '@polygonlabs/oms-wallet';

import { findNetworkById } from '@polygonlabs/oms-wallet';

import type { Plan } from './plan.ts';

import { httpStatus, keyRefused, mapOmsError, MoneyError, upstreamErrorName } from './errors.ts';
import { chainLabel, findSupportedToken } from './tokens.ts';

export type SpendPurpose = 'send' | 'trade' | 'x402';

export interface TransferRecord {
  id: string;
  state: 'preparing' | 'prepared' | 'uncertain' | 'executed' | 'failed';
  chainId: number;
  token: string;
  symbol: string;
  to: string;
  amount: string;
  usd: number;
  purpose: SpendPurpose;
  ref?: string;
  walletId: string;
  sessionId: string;
  txnId?: string;
  executedAt?: string;
  // When the prepared transaction stops being executable.
  quoteExpiresAt?: string;
  txHash?: string;
  error?: string;
  // Set only when it's certain no tokens moved (never prepared or executed,
  // OMS has no record of it, it reverted, or its quote expired unexecuted).
  neverSent?: boolean;
  // Set just before executeTransaction is called.
  executeAttempted?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovedPlan {
  plan: Plan;
  approvedAt: string;
}

/** Where the engine keeps its records: the connection's Durable Object storage. */
export interface TransferStore {
  approved(): Promise<ApprovedPlan | null>;
  transfers(): Promise<TransferRecord[]>;
  putTransfer(record: TransferRecord): Promise<void>;
}

export type RacClient = Pick<
  RemoteAccessClient,
  | 'listSessions'
  | 'getSessionUsage'
  | 'prepareTransaction'
  | 'executeTransaction'
  | 'getTransactionStatus'
>;

export interface EngineDeps {
  store: TransferStore;
  client: RacClient;
  walletAddress: string;
  // When the connection's key stops working, for telling expired from revoked.
  keyExpiresAt: string;
  balanceOf: (params: { chainId: number; token: Address }) => Promise<bigint>;
  usdPrice: (params: { chainId: number; token: Address }) => Promise<number | undefined>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

const POLL_MS = 2_000;
const POLL_TIMEOUT_MS = 60_000;
// Without a recorded quote expiry, assume a prepared transaction is dead after this.
const FALLBACK_QUOTE_LIFETIME_MS = 10 * 60 * 1000;
// Slack for our clock when judging another clock's expiry.
const CLOCK_MARGIN_MS = 2 * 60 * 1000;
const USAGE_ATTEMPTS = 5;
const USAGE_RETRY_MS = 3_000;

// --- sessions -----------------------------------------------------------------

export interface LiveGrant {
  token: Address;
  limit: bigint;
  // null when OMS couldn't report usage.
  used: bigint | null;
  remaining: bigint | null;
}

export interface LiveSession {
  chainId: number;
  sessionId: string;
  walletId: string;
  expiresAt: string;
  expired: boolean;
  grants: LiveGrant[];
}

function refused(error: unknown, deps: Pick<EngineDeps, 'keyExpiresAt'>): unknown {
  if (httpStatus(error) === 401) return keyRefused({ error, expiresAt: deps.keyExpiresAt });
  return mapOmsError(error);
}

async function readUsage(params: {
  deps: EngineDeps;
  sessionId: string;
  chainId: number;
}): Promise<Map<string, bigint | undefined> | null> {
  const network = findNetworkById(params.chainId);
  if (!network) return null;
  // A usage read right after approval has failed with a 500 before succeeding.
  for (let attempt = 1; ; attempt++) {
    try {
      const usage = await params.deps.client.getSessionUsage({
        sessionId: params.sessionId,
        network
      });
      const byToken = new Map<string, bigint | undefined>();
      for (const entry of usage) {
        if (entry.grant.kind === 'erc20Transfer') {
          byToken.set(entry.grant.token.toLowerCase(), entry.used);
        }
      }
      return byToken;
    } catch (error) {
      if (httpStatus(error) === 401) throw error;
      if (attempt >= USAGE_ATTEMPTS) return null;
      await params.deps.sleep(USAGE_RETRY_MS);
    }
  }
}

/** The connection's sessions with their usage, read from OMS. Spending always reads them fresh. */
export async function getSessions(params: {
  deps: EngineDeps;
  chainId?: number;
}): Promise<LiveSession[]> {
  const { deps } = params;
  try {
    const listed = await deps.client.listSessions();
    const sessions: LiveSession[] = [];
    for (const session of listed) {
      if (params.chainId !== undefined && session.chainId !== params.chainId) continue;
      const usage = await readUsage({
        deps,
        sessionId: session.sessionId,
        chainId: session.chainId
      });
      const grants: LiveGrant[] = [];
      for (const grant of session.grants) {
        if (grant.kind !== 'erc20Transfer') continue;
        const used = usage ? (usage.get(grant.token.toLowerCase()) ?? 0n) : null;
        grants.push({
          token: getAddress(grant.token),
          limit: grant.limit,
          used,
          remaining: used === null ? null : grant.limit > used ? grant.limit - used : 0n
        });
      }
      sessions.push({
        chainId: session.chainId,
        sessionId: session.sessionId,
        walletId: session.walletId,
        expiresAt: session.expiresAt,
        expired: Date.parse(session.expiresAt) <= deps.now().getTime(),
        grants
      });
    }
    return sessions;
  } catch (error) {
    throw refused(error, deps);
  }
}

// The live session that can spend `token` on a chain, preferring the most remaining.
export function sessionForToken(params: {
  sessions: LiveSession[];
  chainId: number;
  token: string;
}): { session: LiveSession; grant: LiveGrant } | null {
  const token = params.token.toLowerCase();
  let best: { session: LiveSession; grant: LiveGrant } | null = null;
  for (const session of params.sessions) {
    if (session.chainId !== params.chainId || session.expired) continue;
    const grant = session.grants.find((g) => g.token.toLowerCase() === token);
    if (!grant) continue;
    const rank = (g: LiveGrant) => g.remaining ?? -1n;
    if (!best || rank(grant) > rank(best.grant)) best = { session, grant };
  }
  return best;
}

// --- records ------------------------------------------------------------------

async function update(params: {
  record: TransferRecord;
  deps: EngineDeps;
  patch: Partial<TransferRecord>;
}): Promise<TransferRecord> {
  const record = { ...params.record, ...params.patch, updatedAt: params.deps.now().toISOString() };
  await params.deps.store.putTransfer(record);
  return record;
}

const executedAt = (record: TransferRecord) => record.executedAt ?? record.updatedAt;

/** USD spent since the allowance was approved: every executed transfer since. */
export function spentUsdSince(params: { transfers: TransferRecord[]; since: string }): number {
  const since = Date.parse(params.since);
  const total = params.transfers
    .filter((r) => r.state === 'executed' && Date.parse(executedAt(r)) >= since)
    .reduce((sum, r) => sum + r.usd, 0);
  return Math.round(total * 100) / 100;
}

// Polls OMS until the transaction is executed or failed, for up to a minute.
async function settle(params: {
  record: TransferRecord;
  deps: EngineDeps;
}): Promise<TransferRecord> {
  const { record, deps } = params;
  if (!record.txnId) return record;
  const deadline = deps.now().getTime() + POLL_TIMEOUT_MS;
  for (;;) {
    let status: Awaited<ReturnType<RacClient['getTransactionStatus']>> | undefined;
    try {
      status = await deps.client.getTransactionStatus({ txnId: record.txnId });
    } catch (error) {
      if (httpStatus(error) === 401) throw refused(error, deps);
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
      return update({
        ...params,
        patch: { state: 'executed', txHash: status.txnHash, executedAt: deps.now().toISOString() }
      });
    }
    if (status?.status === 'failed') {
      return update({
        ...params,
        patch: { state: 'failed', neverSent: true, error: 'OMS reported the transaction failed' }
      });
    }
    // Still only quoted: an execute already sent could still land until the
    // quote expires. Only after that is it dead.
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

/**
 * Settles any transfer left prepared or uncertain. Throws upstream_unavailable
 * if one still can't be settled: no new transfer starts until it is.
 */
export async function reconcileTransfers(deps: EngineDeps): Promise<void> {
  for (const record of await deps.store.transfers()) {
    if (record.state === 'preparing') {
      // Stopped before a txnId was saved, so it was never executed.
      await update({
        record,
        deps,
        patch: { state: 'failed', neverSent: true, error: 'interrupted before preparing' }
      });
      continue;
    }
    if (record.state !== 'prepared' && record.state !== 'uncertain') continue;
    const settled = await settle({ record, deps });
    if (settled.state === 'uncertain') {
      throw new MoneyError({
        code: 'upstream_unavailable',
        message: `A previous transfer (${formatUnits(BigInt(settled.amount), decimalsOf(settled))} ${settled.symbol} on ${chainLabel(settled.chainId)}) hasn't settled yet, so no new transfer will start. Try again in a minute.`,
        details: { pendingTransfer: settled.id, txnId: settled.txnId }
      });
    }
  }
}

function decimalsOf(record: TransferRecord): number {
  return findSupportedToken({ chainId: record.chainId, address: record.token })?.decimals ?? 18;
}

function mapPrepareOrExecuteError(error: unknown): MoneyError | null {
  const message = error instanceof Error ? error.message : String(error);
  if (upstreamErrorName(error) === 'UsageLimitExceeded') {
    return new MoneyError({
      code: 'allowance_exhausted',
      message: 'The on-chain limit for this token is used up.',
      hint: 'Ask the owner to connect again with a higher allowance.',
      cause: error
    });
  }
  if (/sponsor/i.test(message)) {
    return new MoneyError({
      code: 'not_sponsored',
      message: "OMS won't sponsor gas for this transfer, and the allowance can't pay its own gas.",
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

// --- checks and transfers -----------------------------------------------------------

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

/** The checks before a transfer, also used to preview one. */
export async function checkTransfer(params: {
  chainId: number;
  token: Address;
  amount: bigint;
  deps: EngineDeps;
}): Promise<TransferCheck> {
  const { deps } = params;
  const approved = await deps.store.approved();
  if (!approved) {
    throw new MoneyError({
      code: 'not_connected',
      message: "This connection has no approved allowance, so it can't spend.",
      hint: 'Ask the owner to connect again from this app.'
    });
  }
  const sessions = await getSessions({ deps, chainId: params.chainId });
  const found = sessionForToken({ sessions, chainId: params.chainId, token: params.token });
  const planGrant = approved.plan.chains
    .find((chain) => chain.chainId === params.chainId)
    ?.grants.find((grant) => grant.token.toLowerCase() === params.token.toLowerCase());
  const known = findSupportedToken({ chainId: params.chainId, address: params.token });
  const symbol = planGrant?.symbol ?? known?.symbol ?? params.token;
  const decimals = planGrant?.decimals ?? known?.decimals;

  if (!found) {
    if (sessions.length > 0 && sessions.every((session) => session.expired)) {
      throw new MoneyError({
        code: 'session_expired',
        message: `The allowance on ${chainLabel(params.chainId)} has expired.`,
        hint: 'Ask the owner to connect again from this app.'
      });
    }
    throw new MoneyError({
      code: 'not_covered',
      message: `${symbol} on ${chainLabel(params.chainId)} isn't covered by this connection's allowance.`
    });
  }
  if (decimals === undefined) {
    throw new MoneyError({
      code: 'not_covered',
      message: `Token ${params.token} on ${chainLabel(params.chainId)} isn't in the approved allowance.`
    });
  }

  const display = `${formatUnits(params.amount, decimals)} ${symbol}`;
  if (found.grant.remaining !== null && params.amount > found.grant.remaining) {
    throw new MoneyError({
      code: 'allowance_exhausted',
      message: `${display} is more than the ${formatUnits(found.grant.remaining, decimals)} ${symbol} left on ${chainLabel(params.chainId)}.`,
      hint: 'Use a smaller amount, or ask the owner to connect again with a higher allowance.'
    });
  }

  // Valued at the current price only: the price at approval could be weeks old.
  const priceUsd =
    known?.kind === 'usd' || planGrant?.kind === 'usd'
      ? 1
      : await deps.usdPrice({ chainId: params.chainId, token: params.token });
  if (priceUsd === undefined || !Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new MoneyError({
      code: 'upstream_unavailable',
      message: `No current USD price for ${symbol}, so the allowance total can't be checked. Try again shortly.`
    });
  }
  const usd = usdFor({ amount: params.amount, decimals, priceUsd });
  const allowanceUsd = approved.plan.allowanceUsd;
  const spent = spentUsdSince({
    transfers: await deps.store.transfers(),
    since: approved.approvedAt
  });
  if (spent + usd > allowanceUsd) {
    throw new MoneyError({
      code: 'allowance_exhausted',
      message: `${display} (about $${usd}) would take the total spent to $${(spent + usd).toFixed(2)}, past the $${allowanceUsd} allowance.`,
      hint: 'Use a smaller amount, or ask the owner to connect again with a higher allowance.'
    });
  }

  const balance = await deps.balanceOf({
    chainId: params.chainId,
    token: getAddress(params.token)
  });
  if (balance < params.amount) {
    throw new MoneyError({
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

export interface TransferResult {
  txHash: string;
  txnId: string;
  transferId: string;
  usd: number;
}

/** Transfers `amount` of `token` to `to` through the chain's session. */
export async function transfer(params: {
  chainId: number;
  token: Address;
  to: Address;
  amount: bigint;
  purpose: SpendPurpose;
  ref?: string;
  // Don't send after this time (ms), e.g. a trade quote's expiry.
  notAfter?: number;
  deps: EngineDeps;
}): Promise<TransferResult> {
  const { deps } = params;
  const network = findNetworkById(params.chainId);
  if (!network) {
    throw new MoneyError({
      code: 'not_covered',
      message: `Chain ${params.chainId} isn't supported.`
    });
  }
  if (params.amount <= 0n) {
    throw new MoneyError({
      code: 'invalid_input',
      message: 'The amount must be greater than zero.'
    });
  }

  await reconcileTransfers(deps);
  const check = await checkTransfer(params);
  const expired = () => params.notAfter !== undefined && deps.now().getTime() > params.notAfter;
  if (expired()) {
    throw new MoneyError({
      code: 'quote_expired',
      message: 'The quote expired while waiting to send; nothing was sent.',
      hint: 'Quote again.'
    });
  }

  const now = deps.now().toISOString();
  const random = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
  let record: TransferRecord = {
    id: `${Date.now()}-${random}`,
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
    createdAt: now,
    updatedAt: now
  };
  await deps.store.putTransfer(record);

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
    await update({
      record,
      deps,
      patch: { state: 'failed', neverSent: true, error: String(error) }
    });
    throw mapPrepareOrExecuteError(error) ?? refused(error, deps);
  }
  if (!prepared.sponsored) {
    await update({
      record,
      deps,
      patch: { state: 'failed', neverSent: true, error: 'not sponsored' }
    });
    throw new MoneyError({
      code: 'not_sponsored',
      message: `OMS won't sponsor gas for transfers on ${chainLabel(params.chainId)}, and the allowance can't pay its own gas.`
    });
  }
  // Saved before executing, so an interruption from here on is settled, never resent.
  record = await update({
    record,
    deps,
    patch: {
      state: 'prepared',
      txnId: prepared.txnId,
      ...(prepared.expiresAt ? { quoteExpiresAt: prepared.expiresAt } : {})
    }
  });

  // Preparing can take a while: re-check the deadline right before executing.
  if (expired()) {
    await update({
      record,
      deps,
      patch: { state: 'failed', neverSent: true, error: 'past notAfter before executing' }
    });
    throw new MoneyError({
      code: 'quote_expired',
      message: 'The quote expired while preparing the transfer; nothing was sent.',
      hint: 'Quote again.'
    });
  }

  try {
    record = await update({ record, deps, patch: { executeAttempted: true } });
    await deps.client.executeTransaction({ txnId: prepared.txnId });
  } catch (error) {
    const status = httpStatus(error);
    if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      await update({ record, deps, patch: { state: 'failed', error: String(error) } });
      throw mapPrepareOrExecuteError(error) ?? refused(error, deps);
    }
    // A timeout, network error or 5xx: it may or may not have gone through.
    record = await update({ record, deps, patch: { state: 'uncertain' } });
  }

  record = await settle({ record, deps });
  if (record.state === 'executed' && record.txHash) {
    return { txHash: record.txHash, txnId: prepared.txnId, transferId: record.id, usd: record.usd };
  }
  if (record.state === 'failed') {
    throw new MoneyError({
      code: 'upstream_error',
      message: `The transfer failed on ${chainLabel(params.chainId)} (OMS transaction ${prepared.txnId}).`,
      details: { txnId: prepared.txnId }
    });
  }
  throw new MoneyError({
    code: 'upstream_unavailable',
    message: `OMS hasn't confirmed the transfer yet (transaction ${prepared.txnId}). It won't be resent; the next request checks it first.`,
    details: { txnId: prepared.txnId }
  });
}

// After a chain's session is approved: can it get sponsored gas? Prepares a
// zero-amount transfer to the wallet itself and never executes it.
export async function probeSponsorship(params: {
  client: Pick<RemoteAccessClient, 'prepareTransaction'>;
  walletId: string;
  sessionId: string;
  chainId: number;
  token: Address;
  walletAddress: string;
}): Promise<{ sponsored: boolean | null; error?: string }> {
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

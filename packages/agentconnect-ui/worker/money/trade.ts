// Swaps and bridges through Trails, spent from the connection's allowance. The
// same flow as the CLI's session mode (trade/quote.ts, execute.ts, validate.ts):
//
//   quoted ──deposit sent──▶ depositing ──mined + executeIntent──▶ executing
//     │                         │                                  ├─▶ completed
//     └─▶ failed (nothing sent) └─▶ failed (reverted)               ├─▶ refunded
//                                                                  └─▶ failed
//
// The deposit, an ERC-20 transfer to the intent's address, is the only thing
// the wallet signs; it's checked against the request before it's saved and
// again before it's sent. Only covered tokens trade: the source is spent from
// the allowance, and buys of ETH, POL or BTC deliver the chain's covered token.

import {
  createPublicClient,
  decodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  isAddress,
  isHex,
  parseUnits
} from 'viem';
import {
  arbitrum,
  arbitrumNova,
  avalanche,
  base,
  bsc,
  katana,
  mainnet,
  optimism,
  polygon
} from 'viem/chains';

import type { Intent, TrailsApi } from '@0xtrails/api';

import type { EngineDeps } from './engine.ts';
import type { SupportedToken } from './tokens.ts';

import { getSessions, sessionForToken, transfer } from './engine.ts';
import { MoneyError, NOTHING_SENT_CODES } from './errors.ts';
import { chainLabel, parseChain, resolveSupportedSymbol } from './tokens.ts';

export const DEFAULT_SLIPPAGE = 0.005;
const MAX_SLIPPAGE = 0.03;
// A quote is executed within this long, even if Trails would allow longer.
const QUOTE_LIFETIME_MS = 5 * 60 * 1000;
// A quote losing more than this share of its input (fees and price impact) warns.
const HIGH_FEE_SHARE = 0.1;
const RECEIPT_TIMEOUT_MS = 60_000;
const EXECUTE_RETRY_MS = 3_000;
const EXECUTE_TIMEOUT_MS = 60_000;
const POLL_MS = 3_000;
export const DEFAULT_WAIT_MS = 30_000;

export interface TradeRecord {
  intentId: string;
  state: 'quoted' | 'depositing' | 'executing' | 'completed' | 'failed' | 'refunded';
  origin: { chainId: number; token: string; symbol: string; decimals: number; amount: string };
  destination: {
    chainId: number;
    token: string;
    symbol: string;
    decimals: number;
    expectedAmount: string;
    minAmount: string;
  };
  quote: { fromAmountUsd: number; toAmountUsd: number; totalFeeUsd: number; slippage: number };
  expiresAt: string;
  deposit: { to: string; data: string };
  depositAddress: string;
  depositTxHash?: string;
  intentStatus?: string;
  destinationTxHash?: string;
  refundTxHash?: string;
  receivedAmount?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TradeStore {
  trade(intentId: string): Promise<TradeRecord | null>;
  putTrade(record: TradeRecord): Promise<void>;
}

export interface TradeDeps extends EngineDeps {
  trades: TradeStore;
  trails: TrailsApi;
  // The receipt of a deposit, by chain and hash (viem in production).
  waitForReceipt?: (params: {
    chainId: number;
    hash: `0x${string}`;
  }) => Promise<'success' | 'reverted'>;
}

const same = (a: string | undefined, b: string) =>
  typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

function invalidQuote(reason: string): MoneyError {
  return new MoneyError({
    code: 'upstream_invalid_quote',
    message: `Trails returned a quote that doesn't match the request (${reason}); nothing was sent.`,
    hint: 'Quote again.'
  });
}

function chainOf(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const chainId = parseChain(value);
  if (chainId === undefined) {
    throw new MoneyError({ code: 'invalid_input', message: `Unknown chain: ${value}.` });
  }
  return chainId;
}

function coveredToken(chainId: number, symbol: string): SupportedToken {
  const token = resolveSupportedSymbol({ chainId, symbol });
  if (!token) {
    throw new MoneyError({
      code: 'not_covered',
      message: `${symbol.toUpperCase()} on ${chainLabel(chainId)} isn't one of the tokens this connection can trade.`
    });
  }
  return token;
}

/** A decimal amount in a token's units, refusing more precision than the token has. */
export function tokenUnits(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match || (match[2]?.length ?? 0) > decimals) {
    throw new MoneyError({
      code: 'invalid_input',
      message: `Not an amount: "${amount}". Use a positive number with at most ${decimals} decimal places.`
    });
  }
  const units = parseUnits(trimmed, decimals);
  if (units <= 0n) {
    throw new MoneyError({
      code: 'invalid_input',
      message: 'The amount must be greater than zero.'
    });
  }
  return units;
}

// Checks Trails' quote before anything is saved: the deposit must be exactly a
// transfer of the quoted amount of the source token to the intent's address on
// the source chain, the output must go to the wallet with no contract call, and
// the minimum output must honour the slippage asked for.
export function validateDeposit(params: {
  intent: Pick<
    Intent,
    | 'intentId'
    | 'ownerAddress'
    | 'originChainId'
    | 'destinationChainId'
    | 'originTokenAddress'
    | 'destinationTokenAddress'
    | 'originIntentAddress'
    | 'depositTransaction'
    | 'quoteRequest'
    | 'quote'
  >;
  walletAddress: string;
  origin: { chainId: number; address: string };
  destination: { chainId: number; address: string };
  amount: bigint;
  slippage: number;
}): void {
  const { intent, walletAddress } = params;
  if (!intent.intentId || !/^[\w-]+$/.test(intent.intentId)) throw invalidQuote('bad intent id');
  if (!same(intent.ownerAddress, walletAddress)) throw invalidQuote('owner is not the wallet');
  const request = intent.quoteRequest;
  if (!request || !same(request.destinationToAddress, walletAddress)) {
    throw invalidQuote('output goes to another address');
  }
  if (
    (request.destinationCallData && request.destinationCallData !== '0x') ||
    request.destinationApproveAddress ||
    BigInt(request.destinationCallValue ?? 0) !== 0n
  ) {
    throw invalidQuote('the output would be used in a contract call');
  }
  if (
    request.originTokenAmount === undefined ||
    BigInt(request.originTokenAmount) !== params.amount
  ) {
    throw invalidQuote('the quoted amount differs from the request');
  }
  if (request.tradeType !== undefined && request.tradeType !== 'EXACT_INPUT') {
    throw invalidQuote('not an exact-input trade');
  }
  const expected = BigInt(intent.quote?.toAmount ?? 0);
  const minimum = BigInt(intent.quote?.toAmountMin ?? 0);
  // The minimum may sit below the expected output by at most the slippage
  // (plus 0.01% for Trails' rounding).
  const bps = BigInt(Math.ceil(params.slippage * 10_000)) + 1n;
  if (expected <= 0n || minimum <= 0n || minimum * 10_000n < expected * (10_000n - bps)) {
    throw invalidQuote('the minimum output is below the slippage asked for');
  }
  if (intent.originChainId !== params.origin.chainId) throw invalidQuote('wrong source chain');
  if (intent.destinationChainId !== params.destination.chainId) {
    throw invalidQuote('wrong destination chain');
  }
  if (!same(intent.originTokenAddress, params.origin.address)) {
    throw invalidQuote('wrong source token');
  }
  if (!same(intent.destinationTokenAddress, params.destination.address)) {
    throw invalidQuote('wrong destination token');
  }
  if (!isAddress(intent.originIntentAddress)) throw invalidQuote('no deposit address');
  const deposit = intent.depositTransaction;
  if (!deposit || deposit.chainId !== params.origin.chainId) {
    throw invalidQuote('deposit on another chain');
  }
  checkDepositCall({
    deposit: { to: deposit.to, data: deposit.data, value: String(deposit.value ?? 0) },
    token: params.origin.address,
    amount: params.amount,
    depositAddress: intent.originIntentAddress,
    fail: invalidQuote
  });
}

function checkDepositCall(params: {
  deposit: { to: string; data: string; value?: string };
  token: string;
  amount: bigint;
  depositAddress: string;
  fail: (reason: string) => MoneyError;
}): void {
  const { deposit, fail } = params;
  if (!same(deposit.to, params.token)) throw fail('deposit is not a call to the token');
  if (BigInt(deposit.value ?? 0) !== 0n) throw fail('token deposit sends native value');
  if (!isHex(deposit.data)) throw fail('deposit calldata is not hex');
  let decoded: ReturnType<typeof decodeFunctionData<typeof erc20Abi>>;
  try {
    decoded = decodeFunctionData({ abi: erc20Abi, data: deposit.data });
  } catch {
    throw fail('deposit is not an ERC-20 call');
  }
  if (decoded.functionName !== 'transfer') throw fail(`deposit is a ${decoded.functionName}`);
  const [to, amount] = decoded.args;
  if (!same(to, params.depositAddress)) throw fail('deposit to another address');
  if (amount !== params.amount) throw fail('deposit amount differs from the quote');
}

export interface QuoteParams {
  from: string;
  to: string;
  // Exactly one: units of `from`, or US dollars of it.
  amount?: string;
  amountUsd?: number;
  chain?: string;
  toChain?: string;
  slippage?: number;
}

/** Quotes a swap or bridge and saves it for `swap` to execute. Sends nothing. */
export async function quoteSwap(
  params: QuoteParams,
  deps: TradeDeps
): Promise<{ trade: TradeRecord; warnings: string[] }> {
  const slippage = params.slippage ?? DEFAULT_SLIPPAGE;
  if (!Number.isFinite(slippage) || slippage <= 0 || slippage > MAX_SLIPPAGE) {
    throw new MoneyError({
      code: 'invalid_input',
      message: `Slippage must be above 0 and at most ${MAX_SLIPPAGE}.`
    });
  }
  if ((params.amount === undefined) === (params.amountUsd === undefined)) {
    throw new MoneyError({
      code: 'invalid_input',
      message: 'Give exactly one of amount or amount_usd.'
    });
  }
  const originChainId = chainOf(params.chain, 137);
  const destinationChainId = chainOf(params.toChain, originChainId);
  const origin = coveredToken(originChainId, params.from);
  const destination = coveredToken(destinationChainId, params.to);
  if (originChainId === destinationChainId && same(origin.address, destination.address)) {
    throw new MoneyError({
      code: 'invalid_input',
      message: 'The source and destination are the same token on the same chain.'
    });
  }

  let amount: bigint;
  if (params.amount !== undefined) {
    amount = tokenUnits(params.amount, origin.decimals);
  } else {
    const usd = params.amountUsd ?? 0;
    if (!Number.isFinite(usd) || usd <= 0) {
      throw new MoneyError({ code: 'invalid_input', message: 'amount_usd must be positive.' });
    }
    const price =
      origin.kind === 'usd'
        ? 1
        : await deps.usdPrice({ chainId: originChainId, token: origin.address });
    if (!price || !Number.isFinite(price) || price <= 0) {
      throw new MoneyError({
        code: 'upstream_unavailable',
        message: `No USD price for ${origin.symbol}; give the amount in ${origin.symbol} instead.`
      });
    }
    amount = tokenUnits((usd / price).toFixed(origin.decimals), origin.decimals);
  }

  // What the allowance and the wallet can cover, before asking Trails.
  const balance = await deps.balanceOf({ chainId: originChainId, token: origin.address });
  if (balance < amount) {
    throw new MoneyError({
      code: 'insufficient_balance',
      message: `The wallet holds ${formatUnits(balance, origin.decimals)} ${origin.symbol} on ${chainLabel(originChainId)}, less than ${formatUnits(amount, origin.decimals)}.`
    });
  }
  const sessions = await getSessions({ deps, chainId: originChainId });
  const found = sessionForToken({ sessions, chainId: originChainId, token: origin.address });
  if (!found) {
    throw new MoneyError({
      code: 'not_covered',
      message: `${origin.symbol} on ${chainLabel(originChainId)} isn't covered by this connection's allowance.`
    });
  }
  if (found.grant.remaining !== null && amount > found.grant.remaining) {
    throw new MoneyError({
      code: 'allowance_exhausted',
      message: `That's more than the ${formatUnits(found.grant.remaining, origin.decimals)} ${origin.symbol} the allowance has left on ${chainLabel(originChainId)}.`
    });
  }

  const { TradeType } = await import('@0xtrails/api');
  let intent: Intent;
  try {
    ({ intent } = await deps.trails.quoteIntent({
      ownerAddress: deps.walletAddress,
      originChainId,
      originTokenAddress: origin.address,
      destinationChainId,
      destinationTokenAddress: destination.address,
      destinationToAddress: deps.walletAddress,
      originTokenAmount: amount,
      tradeType: TradeType.EXACT_INPUT,
      options: { slippageTolerance: slippage }
    }));
  } catch (error) {
    throw new MoneyError({
      code: 'upstream_error',
      message: `Trails couldn't quote ${origin.symbol} on ${chainLabel(originChainId)} to ${destination.symbol} on ${chainLabel(destinationChainId)}: ${error instanceof Error ? error.message : String(error)}`,
      cause: error
    });
  }
  validateDeposit({
    intent,
    walletAddress: deps.walletAddress,
    origin: { chainId: originChainId, address: origin.address },
    destination: { chainId: destinationChainId, address: destination.address },
    amount,
    slippage
  });

  const warnings: string[] = [];
  const fromUsd = intent.quote?.fromAmountUsd ?? 0;
  const toUsd = intent.quote?.toAmountUsd ?? 0;
  const feeUsd = intent.fees?.totalFeeUsd ?? 0;
  const lossShare = fromUsd > 0 && toUsd > 0 ? (fromUsd - toUsd) / fromUsd : 0;
  if (fromUsd > 0 && feeUsd / fromUsd > HIGH_FEE_SHARE) {
    warnings.push(
      `Fees are $${feeUsd.toFixed(2)}, ${Math.round((feeUsd / fromUsd) * 100)}% of the $${fromUsd.toFixed(2)} being traded.`
    );
  } else if (lossShare > HIGH_FEE_SHARE) {
    warnings.push(
      `It returns $${toUsd.toFixed(2)} for the $${fromUsd.toFixed(2)} being traded, ${Math.round(lossShare * 100)}% less after fees and price impact.`
    );
  }

  const now = deps.now();
  const intentExpiry = Date.parse(intent.expiresAt);
  const expiresAt = new Date(
    Math.min(
      Number.isFinite(intentExpiry) ? intentExpiry : Infinity,
      now.getTime() + QUOTE_LIFETIME_MS
    )
  );
  const trade: TradeRecord = {
    intentId: intent.intentId,
    state: 'quoted',
    origin: {
      chainId: originChainId,
      token: origin.address,
      symbol: origin.symbol,
      decimals: origin.decimals,
      amount: amount.toString()
    },
    destination: {
      chainId: destinationChainId,
      token: destination.address,
      symbol: destination.symbol,
      decimals: destination.decimals,
      expectedAmount: String(intent.quote?.toAmount ?? 0n),
      minAmount: String(intent.quote?.toAmountMin ?? 0n)
    },
    quote: { fromAmountUsd: fromUsd, toAmountUsd: toUsd, totalFeeUsd: feeUsd, slippage },
    expiresAt: expiresAt.toISOString(),
    deposit: { to: intent.depositTransaction.to, data: intent.depositTransaction.data || '0x' },
    depositAddress: intent.originIntentAddress,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
  await deps.trades.putTrade(trade);
  return { trade, warnings };
}

async function updateTrade(
  deps: TradeDeps,
  trade: TradeRecord,
  patch: Partial<TradeRecord>
): Promise<TradeRecord> {
  const next = { ...trade, ...patch, updatedAt: deps.now().toISOString() };
  await deps.trades.putTrade(next);
  return next;
}

// Whether this trade's deposit went out, from the engine's settled records.
async function depositOutcome(
  deps: TradeDeps,
  trade: TradeRecord
): Promise<{ sent: true; txHash: string } | { sent: false } | { sent: 'unknown' }> {
  const records = (await deps.store.transfers()).filter((r) => r.ref === trade.intentId);
  const executed = records.find((r) => r.state === 'executed' && r.txHash);
  if (executed?.txHash) return { sent: true, txHash: executed.txHash };
  if (records.every((r) => r.state === 'failed' && r.neverSent === true)) return { sent: false };
  return { sent: 'unknown' };
}

async function sendDeposit(deps: TradeDeps, trade: TradeRecord): Promise<TradeRecord> {
  const deadline = Date.parse(trade.expiresAt);
  if (deps.now().getTime() > deadline) {
    throw new MoneyError({
      code: 'quote_expired',
      message: `The quote expired at ${trade.expiresAt}; nothing was sent.`,
      hint: 'Quote again.'
    });
  }
  // The saved deposit is re-checked: still exactly the quoted transfer.
  checkDepositCall({
    deposit: trade.deposit,
    token: trade.origin.token,
    amount: BigInt(trade.origin.amount),
    depositAddress: trade.depositAddress,
    fail: (reason) =>
      new MoneyError({
        code: 'upstream_invalid_quote',
        message: `The saved trade no longer matches its quote (${reason}); nothing was sent.`,
        hint: 'Quote again.'
      })
  });
  let current = await updateTrade(deps, trade, { state: 'depositing' });
  try {
    const result = await transfer({
      chainId: trade.origin.chainId,
      token: getAddress(trade.origin.token),
      to: getAddress(trade.depositAddress),
      amount: BigInt(trade.origin.amount),
      purpose: 'trade',
      ref: trade.intentId,
      notAfter: deadline,
      deps
    });
    return updateTrade(deps, current, { depositTxHash: result.txHash, error: undefined });
  } catch (error) {
    const recorded = (await deps.store.transfers()).some((r) => r.ref === trade.intentId);
    const refusedBeforeSending =
      error instanceof MoneyError && NOTHING_SENT_CODES.has(error.code) && !recorded;
    const outcome = refusedBeforeSending
      ? { sent: false as const }
      : await depositOutcome(deps, current);
    if (outcome.sent === true) {
      return updateTrade(deps, current, { depositTxHash: outcome.txHash });
    }
    const message = error instanceof Error ? error.message : String(error);
    // Nothing went out: the quote can be tried again until it expires.
    current = await updateTrade(
      deps,
      current,
      outcome.sent === false ? { state: 'quoted', error: message } : { error: message }
    );
    throw error;
  }
}

async function waitForReceipt(params: {
  chainId: number;
  hash: `0x${string}`;
}): Promise<'success' | 'reverted'> {
  const chain = [
    mainnet,
    polygon,
    base,
    arbitrum,
    optimism,
    bsc,
    avalanche,
    arbitrumNova,
    katana
  ].find((c) => c.id === params.chainId);
  if (!chain) throw new Error(`No RPC configuration for chain ${params.chainId}`);
  const client = createPublicClient({ chain, transport: http() });
  const receipt = await client.waitForTransactionReceipt({
    hash: params.hash,
    timeout: RECEIPT_TIMEOUT_MS
  });
  return receipt.status === 'success' ? 'success' : 'reverted';
}

const sleepFor = (deps: TradeDeps, ms: number) => deps.sleep(ms);

async function startIntent(deps: TradeDeps, initial: TradeRecord): Promise<TradeRecord> {
  let trade = initial;
  let txHash = trade.depositTxHash;
  if (!txHash) {
    const outcome = await depositOutcome(deps, trade);
    if (outcome.sent === false) return updateTrade(deps, trade, { state: 'quoted' });
    if (outcome.sent === 'unknown') {
      throw new MoneyError({
        code: 'upstream_unavailable',
        message:
          "The deposit for this trade hasn't settled, or can't be confirmed. It won't be sent again; check it with swap_status.",
        details: { intentId: trade.intentId }
      });
    }
    txHash = outcome.txHash;
    trade = await updateTrade(deps, trade, { depositTxHash: txHash });
  }
  if (!isHex(txHash)) throw new Error(`Not a transaction hash: ${txHash}`);

  let mined: 'success' | 'reverted';
  try {
    mined = await (deps.waitForReceipt ?? waitForReceipt)({
      chainId: trade.origin.chainId,
      hash: txHash
    });
  } catch (error) {
    throw new MoneyError({
      code: 'upstream_unavailable',
      message: `The deposit ${txHash} isn't confirmed yet. It won't be sent again; check it with swap_status.`,
      details: { intentId: trade.intentId },
      cause: error
    });
  }
  if (mined === 'reverted') {
    return updateTrade(deps, trade, {
      state: 'failed',
      error: `The deposit ${txHash} reverted; nothing was traded.`
    });
  }

  const { UnavailableError } = await import('@0xtrails/api');
  const statusOf = () =>
    deps.trails
      .getIntentReceipt({ intentId: trade.intentId })
      .then((res) => res.intentReceipt?.status as string | undefined)
      .catch(() => undefined);
  // An earlier call may have executed it already.
  const known = await statusOf();
  if (known && known !== 'QUOTED' && known !== 'COMMITTED') {
    return updateTrade(deps, trade, { state: 'executing', intentStatus: known });
  }
  const start = deps.now().getTime();
  for (;;) {
    try {
      const res = await deps.trails.executeIntent({
        intentId: trade.intentId,
        depositTransactionHash: txHash
      });
      return updateTrade(deps, trade, {
        state: 'executing',
        intentStatus: String(res.intentStatus)
      });
    } catch (error) {
      const transient = error instanceof UnavailableError;
      if (transient && deps.now().getTime() - start < EXECUTE_TIMEOUT_MS) {
        await sleepFor(deps, EXECUTE_RETRY_MS);
        continue;
      }
      const status = await statusOf();
      if (status && status !== 'QUOTED' && status !== 'COMMITTED') {
        return updateTrade(deps, trade, { state: 'executing', intentStatus: status });
      }
      throw new MoneyError({
        code: transient ? 'upstream_unavailable' : 'upstream_error',
        message: `Trails didn't take the trade after deposit ${txHash}. The deposit won't be sent again; check it with swap_status.`,
        details: { intentId: trade.intentId },
        cause: error
      });
    }
  }
}

async function waitForIntent(
  deps: TradeDeps,
  initial: TradeRecord,
  timeoutMs: number
): Promise<TradeRecord> {
  let trade = initial;
  const deadline = deps.now().getTime() + timeoutMs;
  for (;;) {
    const res = await deps.trails.getIntentReceipt({ intentId: trade.intentId }).catch(() => null);
    const receipt = res?.intentReceipt;
    const status = receipt?.status as string | undefined;
    if (status === 'SUCCEEDED' && receipt) {
      const received = receipt.summary?.destinationTokenAmount;
      return updateTrade(deps, trade, {
        state: 'completed',
        intentStatus: status,
        destinationTxHash:
          receipt.destinationTransaction?.txnHash ?? receipt.originTransaction?.txnHash,
        ...(received !== undefined && received !== null ? { receivedAmount: String(received) } : {})
      });
    }
    if ((status === 'FAILED' || status === 'REFUNDED' || status === 'ABORTED') && receipt) {
      return updateTrade(deps, trade, {
        state: status === 'REFUNDED' ? 'refunded' : 'failed',
        intentStatus: status,
        ...(receipt.refundTransaction?.txnHash
          ? { refundTxHash: receipt.refundTransaction.txnHash }
          : {}),
        error: `Trails reported ${status}`
      });
    }
    if (status && status !== trade.intentStatus) {
      trade = await updateTrade(deps, trade, { intentStatus: status });
    }
    if (deps.now().getTime() >= deadline) return trade;
    await sleepFor(deps, POLL_MS);
  }
}

/**
 * Moves a trade as far as it can go: sends the deposit (unless `send` is
 * false), executes the intent and waits up to `waitMs` for Trails to finish.
 * Returns the trade in its latest state, `executing` if Trails is still working.
 */
export async function executeSwap(
  deps: TradeDeps,
  intentId: string,
  opts: { send: boolean; waitMs?: number }
): Promise<TradeRecord> {
  let trade = await deps.trades.trade(intentId);
  if (!trade) {
    throw new MoneyError({
      code: 'quote_not_found',
      message: `No quote ${intentId} on this connection.`,
      hint: 'Quote again with swap_quote.'
    });
  }
  if (trade.state === 'quoted') {
    if (!opts.send) return trade;
    trade = await sendDeposit(deps, trade);
  }
  if (trade.state === 'depositing') trade = await startIntent(deps, trade);
  if (trade.state === 'quoted' && opts.send) {
    trade = await sendDeposit(deps, trade);
    if (trade.state === 'depositing') trade = await startIntent(deps, trade);
  }
  if (trade.state === 'executing') {
    trade = await waitForIntent(deps, trade, opts.waitMs ?? DEFAULT_WAIT_MS);
  }
  return trade;
}

/** How a trade reads to a person: amounts in token units. */
export function describeTrade(trade: TradeRecord): Record<string, unknown> {
  const { origin, destination } = trade;
  return {
    intentId: trade.intentId,
    status: trade.state,
    from: {
      amount: formatUnits(BigInt(origin.amount), origin.decimals),
      token: origin.symbol,
      chain: chainLabel(origin.chainId)
    },
    to: {
      expected: formatUnits(BigInt(destination.expectedAmount), destination.decimals),
      minimum: formatUnits(BigInt(destination.minAmount), destination.decimals),
      ...(trade.receivedAmount
        ? { received: formatUnits(BigInt(trade.receivedAmount), destination.decimals) }
        : {}),
      token: destination.symbol,
      chain: chainLabel(destination.chainId)
    },
    usd: {
      in: trade.quote.fromAmountUsd,
      out: trade.quote.toAmountUsd,
      fees: trade.quote.totalFeeUsd
    },
    ...(trade.state === 'quoted' ? { expiresAt: trade.expiresAt } : {}),
    ...(trade.depositTxHash ? { depositTxHash: trade.depositTxHash } : {}),
    ...(trade.destinationTxHash ? { txHash: trade.destinationTxHash } : {}),
    ...(trade.refundTxHash ? { refundTxHash: trade.refundTxHash } : {}),
    ...(trade.error && trade.state !== 'completed' ? { error: trade.error } : {})
  };
}

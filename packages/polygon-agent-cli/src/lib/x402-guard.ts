// Guardrails for x402-pay, on both payment paths (FS §9). Local and editable,
// so they stop mistakes, not attackers (FS §11):
//   - --max-usd: refuse a higher price (x402_price_exceeds_max).
//   - Without --max-usd, a price over x402_max_per_call needs --yes
//     (confirmation_required), so the assistant asks the user first.
//   - x402_daily_max over a rolling 24 hours (daily_limit_exceeded).
// Every payment is reserved in x402-payments.jsonl at its price *before*
// anything is sent (so a crash can't lose it), and released only when it's
// certain the service can't be paid: no authorization left the process (none
// was signed, or recording it failed so it wasn't sent). A sent authorization
// stays counted, since it can settle later. The daily limit counts
// reservations: what services are paid, whether the signer was topped up or
// already held funds.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { encodeFunctionData, erc20Abi, getAddress, isAddress, isHex, parseEventLogs } from 'viem';
import { z } from 'zod';

import { readConfig } from './config.ts';
import { CliError, NOTHING_SENT_CODES } from './errors.ts';
import { appendJsonLine } from './jsonl.ts';
import { LockHeldError, withLock } from './lock.ts';
import { findSupportedToken } from './session/tokens.ts';
import { ensureStorageDir, STORAGE_ROOT } from './storage.ts';
import { formatUnits, getReadRpcUrl, resolveNetwork } from './utils.ts';

const DEFAULT_MAX_PER_CALL_USD = 1;
const DEFAULT_DAILY_MAX_USD = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

const ReservationSchema = z.object({
  ts: z.string(),
  // Absent in entries written before reservations existed.
  id: z.string().optional(),
  walletName: z.string(),
  url: z.string(),
  usd: z.number(),
  txHash: z.string().optional()
});
const ReleaseSchema = z.object({ ts: z.string(), id: z.string(), release: z.literal(true) });
// A signed authorization: until it expires it may still settle, so the signer
// funds it covers aren't free for another call, unless a settled entry for the
// same id follows.
const PendingSchema = z.object({
  ts: z.string(),
  id: z.string(),
  pending: z.object({
    chainId: z.number(),
    asset: z.string(),
    amount: z.string(),
    until: z.string()
  })
});
// The service confirmed it: the funds have left the signer.
const SettledSchema = z.object({ ts: z.string(), id: z.string(), settled: z.literal(true) });

function paymentsFile(): string {
  return path.join(STORAGE_ROOT, 'x402-payments.jsonl');
}

function configUsd(params: { key: string; fallback: number }): number {
  const value = readConfig()[params.key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : params.fallback;
}

// The USD value of a payment in a stablecoin the CLI knows; anything else is
// refused, since it can't be checked against the caps.
export function x402PriceUsd(params: { chainId: number; asset: string; amount: bigint }): number {
  const token = findSupportedToken({ chainId: params.chainId, address: params.asset });
  if (token?.kind !== 'usd') {
    throw new CliError({
      code: 'invalid_input',
      message: `This service asks to be paid in ${params.asset} on chain ${params.chainId}, which isn't a stablecoin the CLI can value, so it won't pay it.`
    });
  }
  return Number(formatUnits(params.amount, token.decimals));
}

export function x402SpentLastDay(now: Date): number {
  let text: string;
  try {
    text = fs.readFileSync(paymentsFile(), 'utf8');
  } catch {
    return 0;
  }
  const since = now.getTime() - DAY_MS;
  const reserved: Array<{ id?: string; usd: number }> = [];
  const released = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const release = ReleaseSchema.safeParse(value);
    if (release.success) {
      released.add(release.data.id);
      continue;
    }
    const entry = ReservationSchema.safeParse(value);
    if (entry.success && Date.parse(entry.data.ts) > since) reserved.push(entry.data);
  }
  const total = reserved
    .filter((entry) => entry.id === undefined || !released.has(entry.id))
    .reduce((sum, entry) => sum + entry.usd, 0);
  return Math.round(total * 1e6) / 1e6;
}

const usdText = (usd: number) => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;

export function checkX402Price(params: {
  usd: number;
  maxUsd?: number;
  yes?: boolean;
  url: string;
  now: Date;
}): void {
  const { usd } = params;
  if (params.maxUsd !== undefined && (!Number.isFinite(params.maxUsd) || params.maxUsd < 0)) {
    throw new CliError({ code: 'invalid_input', message: '--max-usd must be a USD amount.' });
  }
  if (params.maxUsd !== undefined) {
    if (usd > params.maxUsd) {
      throw new CliError({
        code: 'x402_price_exceeds_max',
        message: `The service asks ${usdText(usd)}, more than --max-usd ${params.maxUsd}. Nothing was paid.`
      });
    }
  } else {
    const perCall = configUsd({ key: 'x402_max_per_call', fallback: DEFAULT_MAX_PER_CALL_USD });
    if (usd > perCall && !params.yes) {
      throw new CliError({
        code: 'confirmation_required',
        message: `The service asks ${usdText(usd)}, over the ${usdText(perCall)} per-call limit. Nothing was paid.`,
        hint: 'Ask the user; if they agree, rerun with --yes (or --max-usd <price>).',
        details: { priceUsd: usd, url: params.url }
      });
    }
  }
  const dailyMax = configUsd({ key: 'x402_daily_max', fallback: DEFAULT_DAILY_MAX_USD });
  const spent = x402SpentLastDay(params.now);
  if (spent + usd > dailyMax) {
    throw new CliError({
      code: 'daily_limit_exceeded',
      message: `Paying ${usdText(usd)} would take x402 spending in the last 24 hours to ${usdText(spent + usd)}, over the ${usdText(dailyMax)} daily limit. Nothing was paid.`,
      hint: 'The limit is x402_daily_max in config.json.'
    });
  }
}

function appendEntry(entry: Record<string, unknown>): void {
  ensureStorageDir();
  appendJsonLine({ file: paymentsFile(), entry });
}

// Reserves a payment against the daily limit; returns its id.
export function recordX402Payment(params: {
  walletName: string;
  url: string;
  usd: number;
  txHash?: string;
  now: Date;
}): string {
  const id = randomBytes(8).toString('hex');
  appendEntry({
    ts: params.now.toISOString(),
    id,
    walletName: params.walletName,
    url: params.url,
    usd: params.usd,
    ...(params.txHash ? { txHash: params.txHash } : {})
  });
  return id;
}

// Recorded as the authorization is signed, before it's sent, so a crash can't
// lose it. Throws if it can't be written: the caller must then not send.
export function markAuthorizationPending(params: {
  id: string;
  chainId: number;
  asset: string;
  amount: bigint;
  until: Date;
}): void {
  appendEntry({
    ts: new Date().toISOString(),
    id: params.id,
    pending: {
      chainId: params.chainId,
      asset: params.asset.toLowerCase(),
      amount: params.amount.toString(),
      until: params.until.toISOString()
    }
  });
}

// The amount and expiry of an EIP-3009 authorization as signed.
const SignedPayloadSchema = z.object({
  payload: z.object({
    authorization: z.object({
      value: z.string().regex(/^\d+$/),
      validBefore: z.string().regex(/^\d+$/)
    })
  })
});

export function signedAuthorization(paymentPayload: unknown): {
  amount: bigint;
  validBefore: Date;
} {
  const parsed = SignedPayloadSchema.safeParse(paymentPayload);
  if (!parsed.success) {
    throw new CliError({
      code: 'invalid_input',
      message: 'The signed payment is not an EIP-3009 authorization; it was not sent.'
    });
  }
  const { value, validBefore } = parsed.data.payload.authorization;
  return { amount: BigInt(value), validBefore: new Date(Number(validBefore) * 1000) };
}

// The service confirmed the payment, so its funds are no longer in the signer.
// Never throws: a missed clear only keeps the funds set aside until expiry.
export function settleAuthorizationPending(id: string): void {
  try {
    appendEntry({ ts: new Date().toISOString(), id, settled: true });
  } catch {
    // over-counting is the safe side
  }
}

// Signer funds still promised to unexpired, unconfirmed authorizations.
export function pendingAuthorizations(params: {
  chainId: number;
  asset: string;
  now: Date;
}): bigint {
  let text: string;
  try {
    text = fs.readFileSync(paymentsFile(), 'utf8');
  } catch {
    return 0n;
  }
  const pending = new Map<string, bigint>();
  const settled = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const done = SettledSchema.safeParse(value);
    if (done.success) {
      settled.add(done.data.id);
      continue;
    }
    const entry = PendingSchema.safeParse(value);
    if (
      entry.success &&
      entry.data.pending.chainId === params.chainId &&
      entry.data.pending.asset === params.asset.toLowerCase() &&
      Date.parse(entry.data.pending.until) > params.now.getTime()
    ) {
      // Summed per id: should one payment ever be signed twice, both could settle.
      pending.set(
        entry.data.id,
        (pending.get(entry.data.id) ?? 0n) + BigInt(entry.data.pending.amount)
      );
    }
  }
  let total = 0n;
  for (const [id, amount] of pending) if (!settled.has(id)) total += amount;
  return total;
}

// The service certainly wasn't paid: the reservation no longer counts. Never
// throws (a failed release only over-counts), so it can't mask another error.
export function releaseX402Reservation(id: string): void {
  try {
    appendEntry({ ts: new Date().toISOString(), id, release: true });
  } catch {
    // over-counting is the safe side
  }
}

export { usdText as x402UsdText };

// One x402 payment at a time per install, from the price check to the
// service's answer: concurrent calls can't both pass the daily limit, nor both
// count on the same funds left in the signer.
// A payment can take a few minutes (funding, confirmation, the service), so
// a second call waits up to 5 minutes before giving up.
export async function withX402Lock<T>(params: { fn: () => Promise<T> }): Promise<T> {
  ensureStorageDir();
  try {
    return await withLock({
      dir: path.join(STORAGE_ROOT, 'locks', 'x402.lock'),
      waitMs: 300_000,
      fn: params.fn
    });
  } catch (error) {
    if (error instanceof LockHeldError) {
      throw new CliError({
        code: 'wallet_busy',
        message:
          'Another x402 payment is still running on this install (a payment can take a few minutes). Try again when it finishes.',
        cause: error
      });
    }
    throw error;
  }
}

// Call under withX402Lock. Checks the price against the limits, reserves it,
// then funds the payment. The reservation is written before anything is sent
// and is released here only if funding certainly sent nothing; the caller
// releases it only if nothing was signed either. Where the funding transfer
// pays the service directly (the bazaar path), a refusal raised after a
// transfer was recorded (e.g. session_revoked while polling) may still have
// paid: `sentAnything` says whether one was, and then the reservation stays.
export async function reserveX402Payment<T>(params: {
  walletName: string;
  url: string;
  usd: number;
  maxUsd?: number;
  yes?: boolean;
  fund: () => Promise<T>;
  sentAnything?: () => boolean;
}): Promise<{ reservationId: string; funded: T }> {
  checkX402Price({ ...params, now: new Date() });
  const reservationId = recordX402Payment({ ...params, now: new Date() });
  try {
    return { reservationId, funded: await params.fund() };
  } catch (error) {
    if (
      error instanceof CliError &&
      NOTHING_SENT_CODES.has(error.code) &&
      !(params.sentAnything?.() ?? false)
    ) {
      releaseX402Reservation(reservationId);
    }
    throw error;
  }
}

// An ERC-20 balance read from the chain (not the indexer, which lags).
async function publicClient(chainId: number) {
  const { createPublicClient, http } = await import('viem');
  const chains = await import('viem/chains');
  const chain = Object.values(chains).find((c) => c.id === chainId);
  if (!chain) throw new Error(`No RPC configuration for chain ${chainId}`);
  return createPublicClient({
    chain,
    transport: http(
      process.env.SEQUENCE_PROJECT_ACCESS_KEY
        ? getReadRpcUrl(resolveNetwork(chainId))
        : chain.rpcUrls.default.http[0]
    )
  });
}

export async function readTokenBalance(params: {
  chainId: number;
  token: `0x${string}`;
  owner: `0x${string}`;
}): Promise<bigint> {
  const client = await publicClient(params.chainId);
  return client.readContract({
    address: params.token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [params.owner]
  });
}

// Whether a mined transaction moved at least `amount` of `token` to `to`
// (false while unknown). The token's own Transfer event is the proof: a
// relayed wallet transaction can succeed while its inner call didn't.
export async function transferLanded(params: {
  chainId: number;
  txHash: string;
  token: `0x${string}`;
  to: `0x${string}`;
  amount: bigint;
}): Promise<boolean> {
  if (!isHex(params.txHash)) return false;
  const client = await publicClient(params.chainId);
  const receipt = await client
    .getTransactionReceipt({ hash: params.txHash })
    .catch(() => undefined);
  if (receipt?.status !== 'success') return false;
  const transfers = parseEventLogs({
    abi: erc20Abi,
    eventName: 'Transfer',
    logs: receipt.logs.filter((log) => log.address.toLowerCase() === params.token.toLowerCase())
  });
  const received = transfers
    .filter((log) => log.args.to.toLowerCase() === params.to.toLowerCase())
    .reduce((sum, log) => sum + log.args.value, 0n);
  return received >= params.amount;
}

// After funding the signer: wait until the funds are visible on chain, then a
// little longer, since the service's facilitator may read from a node a block
// or two behind and would reject the payment as unfunded.
//
// Visible means the balance reached what the top-up produces (`atLeast`), or,
// once the top-up's transfer to the signer is mined, at least `enough` (this
// payment's price). The second covers an earlier authorization settling meanwhile, which
// lowers the balance and what's promised alike: funds leave the signer only
// that way, so the free funds are still at least the free funds before plus
// the top-up, which covers this payment.
export async function waitForSignerFunds(params: {
  chainId: number;
  token: `0x${string}`;
  owner: `0x${string}`;
  atLeast: bigint;
  // The top-up's transaction and amount, and this payment's price.
  funding?: { txHash: string; amount: bigint; enough: bigint };
  timeoutMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (params.timeoutMs ?? 60_000);
  let mined = false;
  for (;;) {
    const balance = await readTokenBalance(params).catch(() => -1n);
    if (balance >= params.atLeast) break;
    if (params.funding && !mined) {
      mined = await transferLanded({
        chainId: params.chainId,
        txHash: params.funding.txHash,
        token: params.token,
        to: params.owner,
        amount: params.funding.amount
      }).catch(() => false);
    }
    if (params.funding && mined && balance >= params.funding.enough) break;
    if (Date.now() >= deadline) {
      throw new CliError({
        code: 'upstream_unavailable',
        message: `The signer ${params.owner} was funded, but the funds aren't visible on chain yet; nothing was paid. They stay in the signer for the next call.`
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  await new Promise((resolve) => setTimeout(resolve, SETTLE_SLACK_MS));
}

const SETTLE_SLACK_MS = 4_000;

// --- the legacy "bazaar" 402 format (x402-api.onrender.com) ---------------
// The wallet pays the recipient directly, so everything in the transfer comes
// from the server: it's parsed strictly, and the transfer is encoded (never
// spliced) so the amount valued is exactly the amount sent.

const POLYGON_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

const address = z.string().refine((value) => isAddress(value), 'not an address');
const positive = z.number().finite().positive();

const CurrentFormat = z.object({
  payment_address: address,
  amount_usdc: positive,
  supported_chains: z.array(z.object({ chain: z.string(), chainId: z.number() })).default([]),
  usdc_contracts: z.record(z.string(), address).default({})
});

const LegacyFormat = z.object({
  payment_details: z.object({
    amount: positive,
    recipient: address.optional(),
    networks: z
      .array(
        z.object({
          network: z.string().optional(),
          chainId: z.number().optional(),
          recipient: address.optional(),
          usdc_contract: address.optional()
        })
      )
      .default([])
  })
});

export interface BazaarPayment {
  chain: string;
  chainId: number;
  recipient: `0x${string}`;
  asset: `0x${string}`;
  amount: bigint;
  usd: number;
  data: `0x${string}`;
}

function invalidPayment(reason: string): CliError {
  return new CliError({
    code: 'invalid_input',
    message: `The service's payment request isn't usable (${reason}); nothing was paid.`
  });
}

// Whether the 402 body uses the bazaar format at all.
export function isBazaarBody(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    ('payment_address' in body || 'payment_details' in body)
  );
}

// chainId: pay on this chain (--chain), or fail; otherwise Polygon first.
export function parseBazaarPayment(params: { body: unknown; chainId?: number }): BazaarPayment {
  const { body } = params;
  let chain: string;
  let chainId: number;
  let recipient: string;
  let asset: string;
  let amountUsd: number;

  const current = CurrentFormat.safeParse(body);
  if (current.success) {
    const { data } = current;
    const polygon = data.supported_chains.find((c) => c.chain === 'polygon' || c.chainId === 137);
    const option =
      params.chainId !== undefined
        ? data.supported_chains.find((c) => c.chainId === params.chainId)
        : (polygon ?? data.supported_chains[0]);
    if (!option) {
      throw invalidPayment(
        params.chainId !== undefined
          ? `it doesn't take payment on chain ${params.chainId}`
          : 'no supported chains'
      );
    }
    chain = option === polygon ? 'polygon' : option.chain;
    chainId = option === polygon ? 137 : option.chainId;
    const contract = data.usdc_contracts[chain] ?? (chainId === 137 ? POLYGON_USDC : undefined);
    if (!contract) throw invalidPayment(`no USDC contract for ${chain}`);
    asset = contract;
    recipient = data.payment_address;
    amountUsd = data.amount_usdc;
  } else {
    const legacy = LegacyFormat.safeParse(body);
    if (!legacy.success) throw invalidPayment(legacy.error.issues[0]?.message ?? 'bad format');
    const details = legacy.data.payment_details;
    if (params.chainId !== undefined && params.chainId !== 137) {
      throw invalidPayment(`it only takes payment on Polygon, not chain ${params.chainId}`);
    }
    const polygon = details.networks.find((n) => n.network === 'polygon' || n.chainId === 137);
    if (!polygon) throw invalidPayment('no Polygon payment option');
    const to = polygon.recipient ?? details.recipient;
    if (!to) throw invalidPayment('no recipient');
    chain = 'polygon';
    chainId = 137;
    recipient = to;
    asset = polygon.usdc_contract ?? POLYGON_USDC;
    amountUsd = details.amount;
  }

  const token = findSupportedToken({ chainId, address: asset });
  if (token?.kind !== 'usd') throw invalidPayment(`${asset} isn't a stablecoin the CLI knows`);
  const amount = BigInt(Math.round(amountUsd * 10 ** token.decimals));
  if (amount <= 0n) throw invalidPayment('the amount is 0');
  const to = getAddress(recipient);
  return {
    chain,
    chainId,
    recipient: to,
    asset: getAddress(asset),
    amount,
    usd: x402PriceUsd({ chainId, asset, amount }),
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] })
  };
}

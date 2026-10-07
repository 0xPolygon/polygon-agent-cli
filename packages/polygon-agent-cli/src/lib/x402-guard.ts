// Guardrails for x402-pay, on both payment paths (FS §9). Local and editable,
// so they stop mistakes, not attackers (FS §11):
//   - --max-usd: refuse a higher price (x402_price_exceeds_max).
//   - Without --max-usd, a price over x402_max_per_call needs --yes
//     (confirmation_required), so the assistant asks the user first.
//   - x402_daily_max over a rolling 24 hours (daily_limit_exceeded).
// Payments are logged in x402-payments.jsonl once the wallet has paid.

import fs from 'node:fs';
import path from 'node:path';

import { encodeFunctionData, erc20Abi, getAddress, isAddress } from 'viem';
import { z } from 'zod';

import { readConfig } from './config.ts';
import { CliError, NOTHING_SENT_CODES } from './errors.ts';
import { LockHeldError, withLock } from './lock.ts';
import { findSupportedToken } from './session/tokens.ts';
import { ensureStorageDir, STORAGE_ROOT } from './storage.ts';
import { formatUnits } from './utils.ts';

const DEFAULT_MAX_PER_CALL_USD = 1;
const DEFAULT_DAILY_MAX_USD = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

const PaymentSchema = z.object({
  ts: z.string(),
  walletName: z.string(),
  url: z.string(),
  usd: z.number(),
  txHash: z.string().optional()
});

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
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = PaymentSchema.safeParse(JSON.parse(line));
      if (parsed.success && Date.parse(parsed.data.ts) > since) total += parsed.data.usd;
    } catch {
      // skip
    }
  }
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

export function recordX402Payment(params: {
  walletName: string;
  url: string;
  usd: number;
  txHash?: string;
  now: Date;
}): void {
  ensureStorageDir();
  const entry = {
    ts: params.now.toISOString(),
    walletName: params.walletName,
    url: params.url,
    usd: params.usd,
    ...(params.txHash ? { txHash: params.txHash } : {})
  };
  fs.appendFileSync(paymentsFile(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export { usdText as x402UsdText };

// Checks the price against the limits, pays, and logs the payment, one payment
// at a time per install so concurrent calls can't both pass the daily limit.
// A payment that fails in a way that may still have gone out is logged too.
export async function payWithinLimits<T extends { txHash?: string }>(params: {
  walletName: string;
  url: string;
  usd: number;
  maxUsd?: number;
  yes?: boolean;
  pay: () => Promise<T>;
}): Promise<T> {
  ensureStorageDir();
  const log = (txHash?: string) =>
    recordX402Payment({
      walletName: params.walletName,
      url: params.url,
      usd: params.usd,
      txHash,
      now: new Date()
    });
  try {
    return await withLock({
      dir: path.join(STORAGE_ROOT, 'locks', 'x402.lock'),
      waitMs: 120_000,
      fn: async () => {
        checkX402Price({ ...params, now: new Date() });
        let result: T;
        try {
          result = await params.pay();
        } catch (error) {
          if (!(error instanceof CliError && NOTHING_SENT_CODES.has(error.code))) log();
          throw error;
        }
        log(result.txHash);
        return result;
      }
    });
  } catch (error) {
    if (error instanceof LockHeldError) {
      throw new CliError({
        code: 'wallet_busy',
        message:
          'Another x402 payment is still running on this install. Try again when it finishes.',
        cause: error
      });
    }
    throw error;
  }
}

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

export function parseBazaarPayment(body: unknown): BazaarPayment {
  let chain: string;
  let chainId: number;
  let recipient: string;
  let asset: string;
  let amountUsd: number;

  const current = CurrentFormat.safeParse(body);
  if (current.success) {
    const { data } = current;
    const polygon = data.supported_chains.find((c) => c.chain === 'polygon' || c.chainId === 137);
    const option = polygon ?? data.supported_chains[0];
    if (!option) throw invalidPayment('no supported chains');
    chain = polygon ? 'polygon' : option.chain;
    chainId = polygon ? 137 : option.chainId;
    const contract = data.usdc_contracts[chain] ?? (chainId === 137 ? POLYGON_USDC : undefined);
    if (!contract) throw invalidPayment(`no USDC contract for ${chain}`);
    asset = contract;
    recipient = data.payment_address;
    amountUsd = data.amount_usdc;
  } else {
    const legacy = LegacyFormat.safeParse(body);
    if (!legacy.success) throw invalidPayment(legacy.error.issues[0]?.message ?? 'bad format');
    const details = legacy.data.payment_details;
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

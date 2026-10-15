// Saved trades (trades/<intentId>.json), so a quote can be executed later and
// an interrupted trade resumes from where it stopped:
//
//   quoted ──deposit sent──▶ depositing ──mined + executeIntent──▶ executing
//     │                         │                                  ├─▶ completed
//     └─▶ failed (nothing sent) └─▶ failed (deposit never sent)    ├─▶ refunded
//                                                                  └─▶ failed

import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { CliError } from '../errors.ts';
import { readJsonFile, writeJsonFile } from '../session/state.ts';
import { STORAGE_ROOT } from '../storage.ts';

const TokenSide = z.object({
  chainId: z.number(),
  chain: z.string(),
  token: z.string(),
  symbol: z.string(),
  decimals: z.number()
});

const TradeRecordSchema = z.object({
  intentId: z.string(),
  walletName: z.string(),
  walletAddress: z.string(),
  mode: z.enum(['owner', 'session']),
  state: z.enum(['quoted', 'depositing', 'executing', 'completed', 'failed', 'refunded']),
  origin: TokenSide.extend({ amount: z.string() }),
  destination: TokenSide.extend({ expectedAmount: z.string(), minAmount: z.string() }),
  quote: z.object({
    fromAmountUsd: z.number(),
    toAmountUsd: z.number(),
    totalFeeUsd: z.number(),
    priceImpact: z.number(),
    slippage: z.number(),
    routeProviders: z.array(z.string()),
    intentExpiresAt: z.string()
  }),
  // When this quote may no longer be executed (the intent's expiry, at most 5 minutes).
  expiresAt: z.string(),
  deposit: z.object({ to: z.string(), data: z.string(), value: z.string() }),
  // The intent's deposit address, checked at quote time; the saved deposit
  // must still pay it when sent. (Absent from records saved before it was kept.)
  depositAddress: z.string().optional(),
  depositTxHash: z.string().optional(),
  intentStatus: z.string().optional(),
  destinationTxHash: z.string().optional(),
  refundTxHash: z.string().optional(),
  receivedAmount: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type TradeRecord = z.infer<typeof TradeRecordSchema>;
export type TradeState = TradeRecord['state'];

function tradesDir(): string {
  const dir = path.join(STORAGE_ROOT, 'trades');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function tradeFile(intentId: string): string {
  if (!/^[\w-]+$/.test(intentId)) {
    throw new CliError({ code: 'invalid_input', message: `Not an intent id: ${intentId}` });
  }
  return path.join(tradesDir(), `${intentId}.json`);
}

export function saveTrade(record: TradeRecord): void {
  writeJsonFile({ file: tradeFile(record.intentId), data: record });
}

export function loadTrade(intentId: string): TradeRecord | null {
  const parsed = TradeRecordSchema.safeParse(readJsonFile(tradeFile(intentId)));
  return parsed.success ? parsed.data : null;
}

export function updateTrade(params: {
  record: TradeRecord;
  patch: Partial<TradeRecord>;
  now: Date;
}): TradeRecord {
  const record = { ...params.record, ...params.patch, updatedAt: params.now.toISOString() };
  saveTrade(record);
  return record;
}

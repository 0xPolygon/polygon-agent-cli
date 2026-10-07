// Append-only USD ledger of what the agent moved out through its sessions. The
// running total enforces the allowance's USD amount across tokens and chains.
// It's a local guardrail, not a security bound (the on-chain limits are).

import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { sessionDir } from './state.ts';

export type SpendPurpose = 'send' | 'trade' | 'x402';

const LedgerEntrySchema = z.object({
  ts: z.string(),
  chainId: z.number(),
  token: z.string(),
  symbol: z.string(),
  amount: z.string(),
  usd: z.number(),
  purpose: z.enum(['send', 'trade', 'x402']),
  ref: z.string().optional()
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

function ledgerFile(wallet: string): string {
  return path.join(sessionDir(wallet), 'ledger.jsonl');
}

export function appendLedger(params: { wallet: string; entry: LedgerEntry }): void {
  fs.appendFileSync(ledgerFile(params.wallet), `${JSON.stringify(params.entry)}\n`, {
    mode: 0o600
  });
}

// Unreadable lines are skipped rather than failing every later spend.
export function readLedger(wallet: string): LedgerEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(ledgerFile(wallet), 'utf8');
  } catch {
    return [];
  }
  const entries: LedgerEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = LedgerEntrySchema.safeParse(JSON.parse(line));
      if (parsed.success) entries.push(parsed.data);
    } catch {
      // skip
    }
  }
  return entries;
}

export function spentUsd(params: { wallet: string; since?: string }): number {
  const since = params.since ? Date.parse(params.since) : 0;
  const total = readLedger(params.wallet)
    .filter((entry) => Date.parse(entry.ts) >= since)
    .reduce((sum, entry) => sum + entry.usd, 0);
  return Math.round(total * 100) / 100;
}

// A new allowance period: connect, an allowance change, or renew.
export function resetLedger(wallet: string): void {
  fs.rmSync(ledgerFile(wallet), { force: true });
}

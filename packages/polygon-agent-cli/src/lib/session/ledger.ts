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
  ref: z.string().optional(),
  // The session transfer it records, so recording it again is a no-op.
  transferId: z.string().optional()
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

function ledgerFile(wallet: string): string {
  return path.join(sessionDir(wallet), 'ledger.jsonl');
}

function parseEntry(line: string): LedgerEntry | null {
  try {
    const parsed = LedgerEntrySchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// An append that failed part-way leaves a last line without its newline. A
// complete entry just gets the newline; a fragment is cut off, so the next
// entry starts on a line of its own instead of being glued to it (and lost).
function repairTail(file: string): void {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  if (text === '' || text.endsWith('\n')) return;
  const start = text.lastIndexOf('\n') + 1;
  if (parseEntry(text.slice(start))) {
    fs.appendFileSync(file, '\n');
  } else {
    fs.truncateSync(file, Buffer.byteLength(text.slice(0, start)));
  }
}

export function appendLedger(params: { wallet: string; entry: LedgerEntry }): void {
  const file = ledgerFile(params.wallet);
  repairTail(file);
  fs.appendFileSync(file, `${JSON.stringify(params.entry)}\n`, { mode: 0o600 });
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
    const entry = line.trim() ? parseEntry(line) : null;
    if (entry) entries.push(entry);
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

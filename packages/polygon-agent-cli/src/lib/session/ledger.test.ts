import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ledger-'));

const { appendLedger, readLedger, resetLedger, spentUsd } = await import('./ledger.ts');
const { sessionDir } = await import('./state.ts');

const entry = (ts: string, usd: number) => ({
  ts,
  chainId: 137,
  token: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  symbol: 'USDC',
  amount: String(usd * 1e6),
  usd,
  purpose: 'send' as const
});

describe('ledger', () => {
  it('totals spends since the approval, rounded to cents', () => {
    appendLedger({ wallet: 'a', entry: entry('2026-10-01T00:00:00Z', 50) });
    appendLedger({ wallet: 'a', entry: entry('2026-10-06T00:00:00Z', 10.105) });
    appendLedger({ wallet: 'a', entry: entry('2026-10-07T00:00:00Z', 0.2) });
    expect(spentUsd({ wallet: 'a' })).toBe(60.31);
    expect(spentUsd({ wallet: 'a', since: '2026-10-05T00:00:00Z' })).toBe(10.31);
  });

  it('skips unreadable lines instead of failing', () => {
    appendLedger({ wallet: 'b', entry: entry('2026-10-06T00:00:00Z', 5) });
    fs.appendFileSync(path.join(sessionDir('b'), 'ledger.jsonl'), 'not json\n{"ts":1}\n');
    expect(readLedger('b')).toHaveLength(1);
    expect(spentUsd({ wallet: 'b' })).toBe(5);
  });

  it('resets to zero for a new allowance period', () => {
    appendLedger({ wallet: 'c', entry: entry('2026-10-06T00:00:00Z', 5) });
    resetLedger('c');
    expect(spentUsd({ wallet: 'c' })).toBe(0);
  });
});

// The background waiter's files: the encrypted result, the pid file, and
// waiting for one or the other.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-waiter-'));

const {
  deleteResult,
  latestWaiterRequest,
  pidFile,
  readResult,
  resultFile,
  waitForResult,
  waiterAlive,
  waiterEmailCommand,
  writePid,
  writeResult
} = await import('./waiter.ts');

let wallet: string;
let counter = 0;

beforeEach(() => {
  wallet = `waiter${++counter}`;
});

// A pid that certainly belonged to a process that has exited.
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid;
}

const noSleep = async () => undefined;

describe('result file', () => {
  it('round-trips the result encrypted and owner-only, and deletes it', async () => {
    await writeResult(wallet, 'abc123', { ok: true, connected: true, amount: 5n });
    expect(readResult(wallet, 'abc123')).toEqual({ ok: true, connected: true, amount: '5' });
    const raw = fs.readFileSync(resultFile(wallet, 'abc123'), 'utf8');
    expect(raw).not.toContain('connected');
    expect(fs.statSync(resultFile(wallet, 'abc123')).mode & 0o777).toBe(0o600);
    deleteResult(wallet, 'abc123');
    expect(readResult(wallet, 'abc123')).toBeNull();
  });

  it('refuses a request id that could leave its folder', () => {
    expect(() => resultFile(wallet, '../x')).toThrow('Not a request id');
  });
});

describe('waiterAlive', () => {
  it('is true for a running process and false for a dead one or none', () => {
    expect(waiterAlive(wallet, 'r1')).toBe(false);
    writePid({ wallet, id: 'r1', pid: process.pid, emailCommand: 'retry' });
    expect(waiterAlive(wallet, 'r1')).toBe(true);
    expect(waiterEmailCommand(wallet, 'r1')).toBe('retry');
    writePid({ wallet, id: 'r1', pid: deadPid() });
    expect(waiterAlive(wallet, 'r1')).toBe(false);
  });
});

describe('waitForResult', () => {
  it('returns the result once written', async () => {
    writePid({ wallet, id: 'r1', pid: process.pid });
    let polls = 0;
    const out = await waitForResult({
      wallet,
      id: 'r1',
      timeoutMs: 10_000,
      sleep: async () => {
        if (++polls === 2) await writeResult(wallet, 'r1', { ok: true });
      }
    });
    expect(out).toEqual({ state: 'done', result: { ok: true } });
  });

  it('is still waiting at the timeout while the waiter runs', async () => {
    writePid({ wallet, id: 'r1', pid: process.pid });
    let polls = 0;
    const out = await waitForResult({
      wallet,
      id: 'r1',
      timeoutMs: 2_000,
      sleep: async () => {
        polls++;
      }
    });
    expect(out).toEqual({ state: 'waiting' });
    expect(polls).toBe(4);
  });

  it('is gone with no waiter and no result', async () => {
    expect(await waitForResult({ wallet, id: 'r1', timeoutMs: 2_000, sleep: noSleep })).toEqual({
      state: 'gone'
    });
    writePid({ wallet, id: 'r1', pid: deadPid() });
    expect(await waitForResult({ wallet, id: 'r1', timeoutMs: 2_000, sleep: noSleep })).toEqual({
      state: 'gone'
    });
  });

  it('a result left by a waiter that has exited is still done', async () => {
    await writeResult(wallet, 'r1', { ok: false, code: 'request_cancelled' });
    expect(await waitForResult({ wallet, id: 'r1', timeoutMs: 0, sleep: noSleep })).toEqual({
      state: 'done',
      result: { ok: false, code: 'request_cancelled' }
    });
  });
});

describe('latestWaiterRequest', () => {
  it('finds the newest request with a waiter or a result', async () => {
    expect(latestWaiterRequest(wallet)).toBeNull();
    writePid({ wallet, id: 'old', pid: process.pid });
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(pidFile(wallet, 'old'), past, past);
    await writeResult(wallet, 'new', { ok: true });
    expect(latestWaiterRequest(wallet)).toBe('new');
  });
});

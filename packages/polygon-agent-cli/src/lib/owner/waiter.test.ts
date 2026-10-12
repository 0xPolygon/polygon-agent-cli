// The background waiter's files: the encrypted result, the pid file, and
// waiting for one or the other.

import type { ChildProcess } from 'node:child_process';

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-waiter-'));

const {
  clearWaiterFiles,
  deleteResult,
  liveWaiters,
  latestWaiterRequest,
  pidFile,
  readResult,
  resultFile,
  waitForResult,
  waiterAlive,
  waiterEmailCommand,
  stopWaiter,
  writePid,
  writeResult
} = await import('./waiter.ts');

let wallet: string;
let counter = 0;

const children: ChildProcess[] = [];

beforeEach(() => {
  wallet = `waiter${++counter}`;
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

// A running process whose command line is a waiter's for `id`.
function fakeWaiter(id: string): number {
  const child = spawn(
    process.execPath,
    [
      '-e',
      'setInterval(() => {}, 1000)',
      '--',
      'wallet',
      'confirm',
      '--request',
      id,
      '--browser-waiter'
    ],
    { stdio: 'ignore' }
  );
  children.push(child);
  if (child.pid === undefined) throw new Error('no pid');
  return child.pid;
}

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
  it('is true for a running waiter and false for a dead one or none', () => {
    expect(waiterAlive(wallet, 'r1')).toBe(false);
    writePid({ wallet, id: 'r1', pid: fakeWaiter('r1'), emailCommand: 'retry' });
    expect(waiterAlive(wallet, 'r1')).toBe(true);
    expect(waiterEmailCommand(wallet, 'r1')).toBe('retry');
    writePid({ wallet, id: 'r1', pid: deadPid() });
    expect(waiterAlive(wallet, 'r1')).toBe(false);
    expect(fs.existsSync(pidFile(wallet, 'r1'))).toBe(false);
  });

  it('a reused pid (a live process that is not this waiter) is not the waiter, and its file goes', () => {
    writePid({ wallet, id: 'r1', pid: process.pid });
    expect(waiterAlive(wallet, 'r1')).toBe(false);
    expect(fs.existsSync(pidFile(wallet, 'r1'))).toBe(false);
    // Another request's waiter is not this one's either.
    writePid({ wallet, id: 'r1', pid: fakeWaiter('r2') });
    expect(waiterAlive(wallet, 'r1')).toBe(false);
  });

  it('stopWaiter leaves a process that is not the waiter alone', async () => {
    const pid = fakeWaiter('other');
    writePid({ wallet, id: 'r1', pid });
    await stopWaiter(wallet, 'r1', async () => undefined);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(fs.existsSync(pidFile(wallet, 'r1'))).toBe(false);
  });

  it('stopWaiter ends a running waiter', async () => {
    const pid = fakeWaiter('r1');
    writePid({ wallet, id: 'r1', pid });
    await stopWaiter(wallet, 'r1');
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe('liveWaiters and clearWaiterFiles', () => {
  it('lists running waiters from the pid files, and clears every file', async () => {
    writePid({ wallet, id: 'a1', pid: fakeWaiter('a1') });
    writePid({ wallet, id: 'b2', pid: deadPid() });
    await writeResult(wallet, 'c3', { ok: true });
    expect(liveWaiters(wallet)).toEqual(['a1']);
    clearWaiterFiles(wallet);
    expect(liveWaiters(wallet)).toEqual([]);
    expect(readResult(wallet, 'c3')).toBeNull();
    expect(latestWaiterRequest(wallet)).toBeNull();
  });
});

describe('waitForResult', () => {
  it('returns the result once written', async () => {
    writePid({ wallet, id: 'r1', pid: fakeWaiter('r1') });
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
    writePid({ wallet, id: 'r1', pid: fakeWaiter('r1') });
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
    writePid({ wallet, id: 'r1', pid: deadPid(), emailCommand: 'retry by email' });
    expect(await waitForResult({ wallet, id: 'r1', timeoutMs: 2_000, sleep: noSleep })).toEqual({
      state: 'gone',
      emailCommand: 'retry by email'
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
    writePid({ wallet, id: 'old', pid: deadPid() });
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(pidFile(wallet, 'old'), past, past);
    await writeResult(wallet, 'new', { ok: true });
    expect(latestWaiterRequest(wallet)).toBe('new');
  });
});

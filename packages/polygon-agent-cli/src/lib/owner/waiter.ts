// The background waiter of a browser owner request. The command that starts
// the request returns at once; a detached `wallet confirm --browser-waiter`
// drives the login page's sign-in and leaves what `wallet confirm` would have
// printed in a result file, which `--wait` picks up.
//
// Files, next to the pending request (pending/<wallet>/):
//   waiter-<id>.pid    {pid, emailCommand}: present while the waiter runs
//   result-<id>.json   the result, encrypted like the pending file

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { CliError, bigintReplacer } from '../errors.ts';
import { readJsonFile, writeJsonFile } from '../session/state.ts';
import { decrypt, encrypt, STORAGE_ROOT, walletName } from '../storage.ts';

// Request ids become file names, and `--request` is user input.
const REQUEST_ID = /^[a-z0-9]{1,64}$/;

function requestId(id: string): string {
  if (!REQUEST_ID.test(id)) {
    throw new CliError({
      code: 'invalid_input',
      message: `Not a request id: ${JSON.stringify(id)}`
    });
  }
  return id;
}

function waiterDir(wallet: string): string {
  return path.join(STORAGE_ROOT, 'pending', walletName(wallet));
}

function ensureWaiterDir(wallet: string): void {
  fs.mkdirSync(waiterDir(wallet), { recursive: true, mode: 0o700 });
}

export function resultFile(wallet: string, id: string): string {
  return path.join(waiterDir(wallet), `result-${requestId(id)}.json`);
}

export function pidFile(wallet: string, id: string): string {
  return path.join(waiterDir(wallet), `waiter-${requestId(id)}.pid`);
}

const CipherSchema = z.object({ iv: z.string(), encrypted: z.string(), authTag: z.string() });

// The command that does the same request with an emailed code instead, for
// when the waiter is gone without a result.
const PidSchema = z.object({
  pid: z.number().int().positive(),
  emailCommand: z.string().optional()
});

export async function writeResult(
  wallet: string,
  id: string,
  json: Record<string, unknown>
): Promise<void> {
  ensureWaiterDir(wallet);
  writeJsonFile({
    file: resultFile(wallet, id),
    data: encrypt(JSON.stringify(json, bigintReplacer))
  });
}

export function readResult(wallet: string, id: string): Record<string, unknown> | null {
  const cipher = CipherSchema.safeParse(readJsonFile(resultFile(wallet, id)));
  if (!cipher.success) return null;
  try {
    const parsed: unknown = JSON.parse(decrypt(cipher.data));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function deleteResult(wallet: string, id: string): void {
  fs.rmSync(resultFile(wallet, id), { force: true });
}

function readPid(wallet: string, id: string): z.infer<typeof PidSchema> | null {
  const parsed = PidSchema.safeParse(readJsonFile(pidFile(wallet, id)));
  return parsed.success ? parsed.data : null;
}

export function writePid(params: {
  wallet: string;
  id: string;
  pid: number;
  emailCommand?: string;
}): void {
  ensureWaiterDir(params.wallet);
  writeJsonFile({
    file: pidFile(params.wallet, params.id),
    data: {
      pid: params.pid,
      ...(params.emailCommand ? { emailCommand: params.emailCommand } : {})
    }
  });
}

export function removePid(wallet: string, id: string): void {
  fs.rmSync(pidFile(wallet, id), { force: true });
}

// The email-code variant saved when the waiter was started, if any.
export function waiterEmailCommand(wallet: string, id: string): string | undefined {
  return readPid(wallet, id)?.emailCommand;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it just isn't ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// A pid file can outlive its waiter, and the pid can be reused: the process
// counts as this request's waiter only if its command line says so. A command
// line that can't be read counts as not ours.
function isWaiterProcess(pid: number, id: string): boolean {
  if (!processAlive(pid)) return false;
  try {
    const command = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const words = command.trim().split(/\s+/);
    return words.includes('--browser-waiter') && words.includes(id);
  } catch {
    return false;
  }
}

// True while the request's waiter runs; a pid file left by a dead waiter (or
// naming someone else's process) is removed.
export function waiterAlive(wallet: string, id: string): boolean {
  const record = readPid(wallet, id);
  if (!record) return false;
  if (isWaiterProcess(record.pid, id)) return true;
  removePid(wallet, id);
  return false;
}

function waiterIds(wallet: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(waiterDir(wallet));
  } catch {
    return [];
  }
  return entries.flatMap((entry) => /^waiter-([a-z0-9]+)\.pid$/.exec(entry)?.[1] ?? []);
}

// The requests whose waiters are running, from the pid files (the pending file
// is gone once the owner has signed in, while the waiter runs the action).
export function liveWaiters(wallet: string): string[] {
  return waiterIds(wallet).filter((id) => waiterAlive(wallet, id));
}

// Removes every result and pid file of the wallet (after its waiters stopped).
export function clearWaiterFiles(wallet: string): void {
  fs.rmSync(waiterDir(wallet), { recursive: true, force: true });
}

// The pid is written here as well as by the waiter itself, so a `--wait` run
// right after the start never mistakes a waiter still booting for a dead one.
export function spawnWaiter(params: { wallet: string; id: string; emailCommand?: string }): void {
  const child = spawn(
    process.execPath,
    [
      // The loader flags (tsx in development) come along; built code has none.
      ...process.execArgv,
      process.argv[1],
      'wallet',
      'confirm',
      '--name',
      params.wallet,
      '--request',
      params.id,
      '--browser-waiter'
    ],
    { detached: true, stdio: 'ignore', env: process.env }
  );
  child.unref();
  if (child.pid !== undefined) {
    writePid({
      wallet: params.wallet,
      id: params.id,
      pid: child.pid,
      emailCommand: params.emailCommand
    });
  }
}

const STOP_WAIT_MS = 5_000;
const STOP_POLL_MS = 100;

// Stops a running waiter (SIGTERM runs its interrupt handling, which takes the
// request's sign-in key off the disk), and waits briefly for it to exit, so a
// request saved after this is not removed by it. Errors are ignored.
export async function stopWaiter(
  wallet: string,
  id: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<void> {
  try {
    const record = readPid(wallet, id);
    if (!record) return;
    if (!isWaiterProcess(record.pid, id)) {
      removePid(wallet, id);
      return;
    }
    process.kill(record.pid, 'SIGTERM');
    for (
      let waited = 0;
      waited < STOP_WAIT_MS && processAlive(record.pid);
      waited += STOP_POLL_MS
    ) {
      await sleep(STOP_POLL_MS);
    }
    removePid(wallet, id);
  } catch {
    // Nothing to stop, or not ours to stop.
  }
}

// The latest browser request with a waiter or a result for the wallet, for
// `wallet login --wait`, which isn't told the request id.
export function latestWaiterRequest(wallet: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(waiterDir(wallet));
  } catch {
    return null;
  }
  let latest: { id: string; mtime: number } | null = null;
  for (const entry of entries) {
    const match = /^(?:result-([a-z0-9]+)\.json|waiter-([a-z0-9]+)\.pid)$/.exec(entry);
    const id = match?.[1] ?? match?.[2];
    if (!id) continue;
    const mtime = fs.statSync(path.join(waiterDir(wallet), entry)).mtimeMs;
    if (!latest || mtime > latest.mtime) latest = { id, mtime };
  }
  return latest?.id ?? null;
}

const POLL_MS = 500;

// Waits up to `timeoutMs` for the waiter's result. `gone`: no result, and no
// waiter running to write one.
export async function waitForResult(params: {
  wallet: string;
  id: string;
  timeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<
  | { state: 'done'; result: Record<string, unknown> }
  | { state: 'waiting' }
  | { state: 'gone'; emailCommand?: string }
> {
  const sleep = params.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let waited = 0; ; waited += POLL_MS) {
    const result = readResult(params.wallet, params.id);
    if (result) return { state: 'done', result };
    // Read first: a dead waiter's pid file is removed by the check.
    const emailCommand = waiterEmailCommand(params.wallet, params.id);
    if (!waiterAlive(params.wallet, params.id)) {
      // It may have written the result just before exiting.
      const last = readResult(params.wallet, params.id);
      if (last) return { state: 'done', result: last };
      return emailCommand ? { state: 'gone', emailCommand } : { state: 'gone' };
    }
    if (waited >= params.timeoutMs) return { state: 'waiting' };
    await sleep(POLL_MS);
  }
}

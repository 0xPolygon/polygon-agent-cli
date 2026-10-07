// Exclusive locks between CLI processes (e.g. two `update` runs on one
// workspace), safe when holders crash.
//
// A lock is a directory of numbered generation files, each naming its holder.
// The highest generation is the lock's current state:
//   - Acquire: if the highest generation's holder is gone (a dead process on
//     this host, or an unreadable file left long enough), create the next
//     generation with O_EXCL. Only one process can create a given generation,
//     so two processes that both found the same holder dead can't both get in.
//     The winner then checks that no higher generation exists (else it backs
//     off) and removes the older ones, which can only be dead or released.
//   - Release: delete only your own generation file.
// Nothing ever deletes or replaces another live holder's file, so a takeover
// can't evict a live holder and a release can't free someone else's lock.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

const LockHolder = z.object({ pid: z.number(), host: z.string(), startedAt: z.string() });
type LockHolder = z.infer<typeof LockHolder>;

// An unreadable generation (its writer died mid-write) counts as gone after this.
const UNREADABLE_STALE_MS = 10 * 60 * 1000;
// Rounds of losing a race to a dead holder's successor before giving up.
const MAX_ATTEMPTS = 5;

const GENERATION = /^(\d{12})\.json$/;

export class LockHeldError extends Error {
  dir: string;
  holder: LockHolder | null;

  constructor(params: { dir: string; holder: LockHolder | null }) {
    const { dir, holder } = params;
    super(
      holder
        ? `Another process (pid ${holder.pid} on ${holder.host}, since ${holder.startedAt}) holds ${dir}`
        : `Another process holds ${dir}`
    );
    this.name = 'LockHeldError';
    this.dir = dir;
    this.holder = holder;
  }
}

function generationPath(params: { dir: string; generation: number }): string {
  return path.join(params.dir, `${String(params.generation).padStart(12, '0')}.json`);
}

function generations(dir: string): number[] {
  return fs
    .readdirSync(dir)
    .map((name) => GENERATION.exec(name))
    .filter((match) => match !== null)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b);
}

function readHolder(file: string): LockHolder | null {
  try {
    const parsed = LockHolder.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

// Gone only when provably so: released (file removed), a holder on this host
// whose process isn't running, or a file nobody could read for a while.
function isGone(file: string): boolean {
  const holder = readHolder(file);
  if (holder) return holder.host === os.hostname() && !isAlive(holder.pid);
  try {
    return Date.now() - fs.statSync(file).mtimeMs > UNREADABLE_STALE_MS;
  } catch {
    return true;
  }
}

function tryCreate(file: string): boolean {
  const holder: LockHolder = {
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date().toISOString()
  };
  try {
    fs.writeFileSync(file, JSON.stringify(holder), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false;
    throw error;
  }
}

function held(params: { dir: string; generation: number }): LockHeldError {
  return new LockHeldError({ dir: params.dir, holder: readHolder(generationPath(params)) });
}

// Returns the generation this process now holds, or throws LockHeldError.
function acquire(dir: string): number {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const top = generations(dir).at(-1) ?? 0;
    if (top > 0 && !isGone(generationPath({ dir, generation: top }))) {
      throw held({ dir, generation: top });
    }
    const mine = top + 1;
    // Lost the race for this generation: look again.
    if (!tryCreate(generationPath({ dir, generation: mine }))) continue;

    const after = generations(dir);
    const higher = after.find((generation) => generation > mine);
    if (higher !== undefined) {
      fs.rmSync(generationPath({ dir, generation: mine }), { force: true });
      continue;
    }
    for (const generation of after) {
      if (generation < mine) fs.rmSync(generationPath({ dir, generation }), { force: true });
    }
    return mine;
  }
  const top = generations(dir).at(-1) ?? 0;
  throw held({ dir, generation: top });
}

const WAIT_POLL_MS = 100;

// Acquires, retrying while a live holder has the lock, for up to waitMs.
async function acquireWithin(params: { dir: string; waitMs: number }): Promise<number> {
  const deadline = Date.now() + params.waitMs;
  for (;;) {
    try {
      return acquire(params.dir);
    } catch (error) {
      if (!(error instanceof LockHeldError) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
    }
  }
}

// Runs fn while holding the lock directory `dir`. Throws LockHeldError if a
// live process holds it, after waiting up to waitMs (default: fail at once).
export async function withLock<T>(params: {
  dir: string;
  fn: () => Promise<T> | T;
  waitMs?: number;
}): Promise<T> {
  fs.mkdirSync(params.dir, { recursive: true, mode: 0o700 });
  const mine = await acquireWithin({ dir: params.dir, waitMs: params.waitMs ?? 0 });
  try {
    return await params.fn();
  } finally {
    fs.rmSync(generationPath({ dir: params.dir, generation: mine }), { force: true });
  }
}

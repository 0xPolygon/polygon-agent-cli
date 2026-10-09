// Exclusive locks between CLI processes (e.g. two `update` runs on one
// workspace), safe when holders crash.
//
// A lock is a directory of numbered generation files, each naming its holder.
// The highest generation is the lock's current state:
//   - Acquire: if the highest generation's holder is gone (released, a dead
//     process on this host, or an unreadable file left long enough), create the
//     next generation with O_EXCL. Only one process can create a given
//     generation, so two processes that both found the same holder gone can't
//     both get in. The winner then checks that no higher generation exists
//     (else it backs off) and removes the older ones, which can only be gone.
//   - Release: mark your own generation file released (an atomic replace). It
//     stays as the highest generation until the next holder replaces it.
// The highest generation number therefore never goes down, so a process that
// judged the lock free and resumes late always finds a newer generation and
// backs off. Nothing deletes or replaces another live holder's file, so a
// takeover can't evict a live holder and a release can't free someone else's.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

const LockHolder = z.object({
  pid: z.number(),
  host: z.string(),
  startedAt: z.string(),
  // The holder process's start time in /proc ticks (Linux), to tell it from a
  // later process given the same pid.
  startTicks: z.number().optional(),
  released: z.boolean().optional()
});
type LockHolder = z.infer<typeof LockHolder>;

// An unreadable generation (its writer died mid-write) counts as gone after this.
const UNREADABLE_STALE_MS = 10 * 60 * 1000;
// Rounds of losing a race to a dead holder's successor before giving up.
const MAX_ATTEMPTS = 5;

const GENERATION = /^(\d{12})\.json$/;
// A release's temporary file (left behind only if the releaser crashed).
const RELEASING = /^(\d{12})\.json\..+\.tmp$/;

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

// A process's start time since boot, in clock ticks (1/100 s), from
// /proc/<pid>/stat on Linux; null elsewhere or if it can't be read.
function processStartTicks(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Fields after the command name (which may hold spaces) start at field 3;
    // starttime is field 22.
    const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

// A live process with the holder's pid may be another process given the same
// pid later (after a container restart, say). On Linux their start times
// differ; elsewhere only this process's own start can be told, from its
// uptime, so a reused pid of another process is taken to be the holder.
const START_SLACK_MS = 2_000;

function isHolderRunning(holder: LockHolder): boolean {
  if (!isAlive(holder.pid)) return false;
  const ticks = processStartTicks(holder.pid);
  if (ticks !== null && holder.startTicks !== undefined) return ticks === holder.startTicks;
  const takenAt = Date.parse(holder.startedAt);
  if (holder.pid !== process.pid || !Number.isFinite(takenAt)) return true;
  return Date.now() - process.uptime() * 1000 <= takenAt + START_SLACK_MS;
}

// Gone only when provably so: released, a holder on this host whose process
// isn't running (no process with its pid, or one that started after it took
// the lock), or a file nobody could read for a while.
function isGone(file: string): boolean {
  const holder = readHolder(file);
  if (holder?.released) return true;
  if (holder) return holder.host === os.hostname() && !isHolderRunning(holder);
  try {
    return Date.now() - fs.statSync(file).mtimeMs > UNREADABLE_STALE_MS;
  } catch {
    return true;
  }
}

function tryCreate(file: string): boolean {
  const ticks = processStartTicks(process.pid);
  const holder: LockHolder = {
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date().toISOString(),
    ...(ticks !== null ? { startTicks: ticks } : {})
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
    for (const name of fs.readdirSync(dir)) {
      const match = GENERATION.exec(name) ?? RELEASING.exec(name);
      if (match && Number(match[1]) < mine) fs.rmSync(path.join(dir, name), { force: true });
    }
    return mine;
  }
  const top = generations(dir).at(-1) ?? 0;
  throw held({ dir, generation: top });
}

// Marks this process's generation released, atomically, so it is never seen
// half-written. The file stays: the generation number must not be reused.
function release(params: { dir: string; generation: number }): void {
  const file = generationPath(params);
  const held = readHolder(file);
  const holder: LockHolder = {
    pid: process.pid,
    host: os.hostname(),
    startedAt: held?.startedAt ?? new Date().toISOString(),
    ...(held?.startTicks !== undefined ? { startTicks: held.startTicks } : {}),
    released: true
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(holder), { mode: 0o600 });
  fs.renameSync(tmp, file);
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
    // If marking the release fails (e.g. a full disk), the generation still
    // names this process, which counts as gone once it exits.
    try {
      release({ dir: params.dir, generation: mine });
    } catch {
      // best effort
    }
  }
}

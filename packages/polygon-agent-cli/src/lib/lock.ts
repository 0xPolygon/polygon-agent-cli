// Exclusive file locks between CLI processes (e.g. two `update` runs on one
// workspace). A lock is a file created with O_EXCL that names its holder; a lock
// left by a process that died on this host is taken over.

import fs from 'node:fs';
import os from 'node:os';

import { z } from 'zod';

const LockHolder = z.object({ pid: z.number(), host: z.string(), startedAt: z.string() });
type LockHolder = z.infer<typeof LockHolder>;

// An unreadable lock (its writer died mid-write) counts as stale after this.
const UNREADABLE_STALE_MS = 10 * 60 * 1000;

export class LockHeldError extends Error {
  file: string;
  holder: LockHolder | null;

  constructor(params: { file: string; holder: LockHolder | null }) {
    const { file, holder } = params;
    super(
      holder
        ? `Another process (pid ${holder.pid} on ${holder.host}, since ${holder.startedAt}) holds ${file}`
        : `Another process holds ${file}`
    );
    this.name = 'LockHeldError';
    this.file = file;
    this.holder = holder;
  }
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

// Stale only when provably gone: a holder on this host whose process isn't
// running, or a lock nobody could read for a while.
function isStale(file: string): boolean {
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

// Runs fn while holding the lock; throws LockHeldError if a live process has it.
export async function withLock<T>(params: { file: string; fn: () => Promise<T> | T }): Promise<T> {
  if (!tryCreate(params.file)) {
    if (!isStale(params.file)) {
      throw new LockHeldError({ file: params.file, holder: readHolder(params.file) });
    }
    fs.rmSync(params.file, { force: true });
    if (!tryCreate(params.file)) {
      throw new LockHeldError({ file: params.file, holder: readHolder(params.file) });
    }
  }
  try {
    return await params.fn();
  } finally {
    fs.rmSync(params.file, { force: true });
  }
}

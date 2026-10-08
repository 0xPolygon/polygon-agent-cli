import type { ChildProcess } from 'node:child_process';

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LockHeldError, withLock } from './lock.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pa-lock-'));
}

function lockDir(): string {
  return path.join(tmpDir(), 'update.lock');
}

function generationFile(params: { dir: string; generation: number }): string {
  return path.join(params.dir, `${String(params.generation).padStart(12, '0')}.json`);
}

function writeHolder(params: {
  dir: string;
  generation: number;
  pid: number;
  host?: string;
  startedAt?: Date;
}) {
  fs.mkdirSync(params.dir, { recursive: true });
  fs.writeFileSync(
    generationFile(params),
    JSON.stringify({
      pid: params.pid,
      host: params.host ?? os.hostname(),
      startedAt: (params.startedAt ?? new Date()).toISOString()
    })
  );
}

// Each generation file in the lock directory and whether it is released.
function generationsState(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .sort()
    .map((name) => {
      const holder = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      return `${name}:${holder.released ? 'released' : 'held'}`;
    });
}

// The pid of a process that has already exited.
function deadPid(): number {
  return Number(
    execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' })
  );
}

describe('withLock', () => {
  it('runs fn, returns its result and releases the lock', async () => {
    const dir = lockDir();
    expect(await withLock({ dir, fn: () => 42 })).toBe(42);
    expect(generationsState(dir)).toEqual(['000000000001.json:released']);
  });

  it('never reuses a generation number: the next holder continues from a release', async () => {
    const dir = lockDir();
    await withLock({ dir, fn: () => undefined });
    let during: string[] = [];
    await withLock({ dir, fn: () => (during = generationsState(dir)) });
    expect(during).toEqual(['000000000002.json:held']);
    expect(generationsState(dir)).toEqual(['000000000002.json:released']);
  });

  it('releases the lock when fn throws', async () => {
    const dir = lockDir();
    await expect(
      withLock({
        dir,
        fn: () => {
          throw new Error('boom');
        }
      })
    ).rejects.toThrow('boom');
    expect(generationsState(dir)).toEqual(['000000000001.json:released']);
  });

  it('refuses while another holder is running, without running fn', async () => {
    const dir = lockDir();
    let ran = false;
    await withLock({
      dir,
      fn: async () => {
        await expect(
          withLock({
            dir,
            fn: () => {
              ran = true;
            }
          })
        ).rejects.toBeInstanceOf(LockHeldError);
      }
    });
    expect(ran).toBe(false);
  });

  it('takes over from a process that died on this host, and clears its generation', async () => {
    const dir = lockDir();
    writeHolder({ dir, generation: 1, pid: deadPid() });
    let during: string[] = [];
    expect(
      await withLock({
        dir,
        fn: () => {
          during = fs.readdirSync(dir);
          return 'ok';
        }
      })
    ).toBe('ok');
    expect(during).toEqual(['000000000002.json']);
    expect(generationsState(dir)).toEqual(['000000000002.json:released']);
  });

  it('does not take over a lock held by a live process', async () => {
    const dir = lockDir();
    writeHolder({ dir, generation: 1, pid: process.pid });
    await expect(withLock({ dir, fn: () => 'ok' })).rejects.toThrow(/pid \d+ on /);
    expect(fs.readdirSync(dir)).toEqual(['000000000001.json']);
  });

  it('takes over from a holder whose pid now belongs to a newer process (pid reuse after a restart)', async () => {
    const dir = lockDir();
    // This process's pid, but a lock taken a day before this process started.
    writeHolder({
      dir,
      generation: 1,
      pid: process.pid,
      startedAt: new Date(Date.now() - process.uptime() * 1000 - 86_400_000)
    });
    expect(await withLock({ dir, fn: () => 'ok' })).toBe('ok');
  });

  it.runIf(fs.existsSync('/proc/self/stat'))(
    'takes over from a holder whose pid now runs a process with another start time',
    async () => {
      const dir = lockDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        generationFile({ dir, generation: 1 }),
        // This pid, but started at another tick than this process did.
        JSON.stringify({
          pid: process.pid,
          host: os.hostname(),
          startedAt: new Date().toISOString(),
          startTicks: 1
        })
      );
      expect(await withLock({ dir, fn: () => 'ok' })).toBe('ok');
    }
  );

  it('does not take over a lock from another host it cannot check', async () => {
    const dir = lockDir();
    writeHolder({ dir, generation: 1, pid: deadPid(), host: 'some-other-host' });
    await expect(withLock({ dir, fn: () => 'ok' })).rejects.toBeInstanceOf(LockHeldError);
  });

  it('treats an unreadable generation as held until it is old', async () => {
    const dir = lockDir();
    fs.mkdirSync(dir);
    const file = generationFile({ dir, generation: 1 });
    fs.writeFileSync(file, '');
    await expect(withLock({ dir, fn: () => 'ok' })).rejects.toBeInstanceOf(LockHeldError);

    const old = new Date(Date.now() - 11 * 60 * 1000);
    fs.utimesSync(file, old, old);
    expect(await withLock({ dir, fn: () => 'ok' })).toBe('ok');
  });

  it('releases only its own generation', async () => {
    const dir = lockDir();
    await withLock({
      dir,
      // Someone else's generation appears while this one is held.
      fn: () => writeHolder({ dir, generation: 2, pid: process.pid })
    });
    expect(generationsState(dir)).toEqual(['000000000001.json:released', '000000000002.json:held']);
  });
});

// --- Real processes ---------------------------------------------------------

// A child that takes the lock in <base>/update.lock and holds it until
// <base>/<role>.finish exists, leaving <role>.in when inside. With pause, it
// stops before its first change to the lock directory (after judging the lock
// free) until <base>/<role>.go exists.
const CHILD = `
import fs from 'node:fs';
import path from 'node:path';
import { withLock } from ${JSON.stringify(path.join(import.meta.dirname, 'lock.ts'))};

const [role, base, pause, holdMs] = process.argv.slice(1);
const dir = path.join(base, 'update.lock');
const write = fs.writeFileSync;
const mark = (m) => write(path.join(base, role + '.' + m), '');
const has = (m) => fs.existsSync(path.join(base, role + '.' + m));
// Pause before this process first changes anything in the lock directory:
// that's after it has judged the lock free, and before it acts on that.
let intercept = pause === '1';
function pauseOnce(file) {
  if (!intercept || !String(file).startsWith(dir + path.sep)) return;
  intercept = false;
  mark('ready');
  while (!has('go')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
for (const name of ['rmSync', 'unlinkSync', 'renameSync']) {
  const original = fs[name];
  fs[name] = (file, ...rest) => {
    pauseOnce(file);
    return original(file, ...rest);
  };
}
fs.writeFileSync = (file, data, options) => {
  // An exclusive create only changes anything if the file doesn't exist yet.
  if (options?.flag === 'wx' && !fs.existsSync(file)) pauseOnce(file);
  return write(file, data, options);
};
try {
  await withLock({ dir, fn: async () => {
    fs.appendFileSync(path.join(base, 'log'), 'in ' + role + '\\n');
    mark('in');
    if (holdMs) await new Promise((r) => setTimeout(r, Number(holdMs)));
    else while (!has('finish')) await new Promise((r) => setTimeout(r, 10));
    fs.appendFileSync(path.join(base, 'log'), 'out ' + role + '\\n');
  } });
  console.log('ran');
} catch (e) {
  console.log(e.name);
}
`;

const children: ChildProcess[] = [];

function launch(params: { role: string; base: string; pause?: boolean; holdMs?: number }) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      CHILD,
      params.role,
      params.base,
      params.pause ? '1' : '0',
      params.holdMs ? String(params.holdMs) : ''
    ],
    { cwd: import.meta.dirname }
  );
  children.push(child);
  let out = '';
  child.stdout?.on('data', (d) => (out += d));
  return new Promise<string>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', () => resolve(out.trim()));
  });
}

async function waitFor(file: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// in/out lines never overlap: every "in X" is followed by "out X".
function expectNoOverlap(log: string): void {
  const lines = log.trim().split('\n');
  expect(lines.length % 2).toBe(0);
  for (let i = 0; i < lines.length; i += 2) {
    expect(lines[i].replace('in ', 'out ')).toBe(lines[i + 1]);
  }
}

describe('withLock across processes', () => {
  afterEach(() => {
    for (const child of children.splice(0)) child.kill();
  });

  it('lets exactly one of two concurrent processes in', async () => {
    const base = tmpDir();
    const results = await Promise.all([
      launch({ role: 'A', base, holdMs: 500 }),
      launch({ role: 'B', base, holdMs: 500 })
    ]);
    expect(results.sort()).toEqual(['LockHeldError', 'ran']);
    expectNoOverlap(fs.readFileSync(path.join(base, 'log'), 'utf8'));
  });

  // Both find the same dead holder and pause right before taking over. The
  // first to resume gets in; the second must not evict it, and the first's
  // release must leave the lock free for a third.
  it('two processes recovering the same stale lock never both get in', async () => {
    const base = tmpDir();
    writeHolder({ dir: path.join(base, 'update.lock'), generation: 1, pid: deadPid() });

    const a = launch({ role: 'A', base, pause: true });
    const b = launch({ role: 'B', base, pause: true });
    await waitFor(path.join(base, 'A.ready'));
    await waitFor(path.join(base, 'B.ready'));

    fs.writeFileSync(path.join(base, 'A.go'), '');
    await waitFor(path.join(base, 'A.in'));
    fs.writeFileSync(path.join(base, 'B.go'), '');
    // B must be refused, not let in alongside A.
    const bOutcome = await Promise.race([
      b,
      waitFor(path.join(base, 'B.in')).then(() => 'B got in while A held the lock')
    ]);
    expect(bOutcome).toBe('LockHeldError');
    expect(fs.existsSync(path.join(base, 'B.in'))).toBe(false);

    fs.writeFileSync(path.join(base, 'A.finish'), '');
    expect(await a).toBe('ran');

    fs.writeFileSync(path.join(base, 'C.finish'), '');
    expect(await launch({ role: 'C', base })).toBe('ran');
    expectNoOverlap(fs.readFileSync(path.join(base, 'log'), 'utf8'));
    expect(
      generationsState(path.join(base, 'update.lock')).every((g) => g.endsWith(':released'))
    ).toBe(true);
  });

  // A judges the dead holder's lock free and pauses. Meanwhile B takes over,
  // finishes and releases, and C takes the lock again. A resumes: it must not
  // evict C, even though the generation it was about to create is free again.
  it('a stale recoverer resuming after a release and re-acquire never gets in', async () => {
    const base = tmpDir();
    writeHolder({ dir: path.join(base, 'update.lock'), generation: 1, pid: deadPid() });

    const a = launch({ role: 'A', base, pause: true });
    await waitFor(path.join(base, 'A.ready'));
    expect(await launch({ role: 'B', base, holdMs: 1 })).toBe('ran');
    const c = launch({ role: 'C', base });
    await waitFor(path.join(base, 'C.in'));

    fs.writeFileSync(path.join(base, 'A.go'), '');
    const aOutcome = await Promise.race([
      a,
      waitFor(path.join(base, 'A.in')).then(() => 'A got in while C held the lock')
    ]);
    expect(aOutcome).toBe('LockHeldError');

    fs.writeFileSync(path.join(base, 'C.finish'), '');
    expect(await c).toBe('ran');
    expectNoOverlap(fs.readFileSync(path.join(base, 'log'), 'utf8'));
  });

  it('many processes racing to recover a stale lock never overlap', async () => {
    const base = tmpDir();
    writeHolder({ dir: path.join(base, 'update.lock'), generation: 1, pid: deadPid() });
    const results = await Promise.all(
      ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((role) => launch({ role, base, holdMs: 300 }))
    );
    expect(results.filter((r) => r === 'ran').length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r === 'ran' || r === 'LockHeldError')).toBe(true);
    expectNoOverlap(fs.readFileSync(path.join(base, 'log'), 'utf8'));
    expect(
      generationsState(path.join(base, 'update.lock')).every((g) => g.endsWith(':released'))
    ).toBe(true);
  });
});

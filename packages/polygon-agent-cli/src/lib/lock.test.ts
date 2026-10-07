import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { LockHeldError, withLock } from './lock.ts';

function lockFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-lock-')), 'test.lock');
}

function writeHolder(params: { file: string; pid: number; host?: string }): void {
  fs.writeFileSync(
    params.file,
    JSON.stringify({
      pid: params.pid,
      host: params.host ?? os.hostname(),
      startedAt: new Date().toISOString()
    })
  );
}

// The pid of a process that has already exited.
function deadPid(): number {
  return Number(
    execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' })
  );
}

describe('withLock', () => {
  it('runs fn, returns its result and releases the lock', async () => {
    const file = lockFile();
    expect(await withLock({ file, fn: () => 42 })).toBe(42);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('releases the lock when fn throws', async () => {
    const file = lockFile();
    await expect(
      withLock({
        file,
        fn: () => {
          throw new Error('boom');
        }
      })
    ).rejects.toThrow('boom');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('refuses while another holder is running, without running fn', async () => {
    const file = lockFile();
    let ran = false;
    await withLock({
      file,
      fn: async () => {
        await expect(
          withLock({
            file,
            fn: () => {
              ran = true;
            }
          })
        ).rejects.toBeInstanceOf(LockHeldError);
      }
    });
    expect(ran).toBe(false);
  });

  it('takes over a lock left by a process that died on this host', async () => {
    const file = lockFile();
    writeHolder({ file, pid: deadPid() });
    expect(await withLock({ file, fn: () => 'ok' })).toBe('ok');
  });

  it('does not take over a lock held by a live process', async () => {
    const file = lockFile();
    writeHolder({ file, pid: process.pid });
    await expect(withLock({ file, fn: () => 'ok' })).rejects.toThrow(/pid \d+ on /);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('does not take over a lock from another host it cannot check', async () => {
    const file = lockFile();
    writeHolder({ file, pid: deadPid(), host: 'some-other-host' });
    await expect(withLock({ file, fn: () => 'ok' })).rejects.toBeInstanceOf(LockHeldError);
  });

  it('treats an unreadable lock as held until it is old', async () => {
    const file = lockFile();
    fs.writeFileSync(file, '');
    await expect(withLock({ file, fn: () => 'ok' })).rejects.toBeInstanceOf(LockHeldError);

    const old = new Date(Date.now() - 11 * 60 * 1000);
    fs.utimesSync(file, old, old);
    expect(await withLock({ file, fn: () => 'ok' })).toBe('ok');
  });

  it('lets exactly one of two concurrent processes in', async () => {
    const file = lockFile();
    const log = `${file}.log`;
    const script = `
      import fs from 'node:fs';
      import { withLock } from ${JSON.stringify(path.join(import.meta.dirname, 'lock.ts'))};
      try {
        await withLock({ file: process.argv[1], fn: async () => {
          fs.appendFileSync(process.argv[2], 'in\\n');
          await new Promise((r) => setTimeout(r, 500));
          fs.appendFileSync(process.argv[2], 'out\\n');
        } });
        console.log('ran');
      } catch (e) {
        console.log(e.name);
      }`;
    const run = () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script, file, log], {
          cwd: import.meta.dirname
        });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.on('error', reject);
        child.on('close', () => resolve(out.trim()));
      });

    const results = await Promise.all([run(), run()]);
    expect(results.sort()).toEqual(['LockHeldError', 'ran']);
    expect(fs.readFileSync(log, 'utf8')).toBe('in\nout\n');
    expect(fs.existsSync(file)).toBe(false);
  });
});

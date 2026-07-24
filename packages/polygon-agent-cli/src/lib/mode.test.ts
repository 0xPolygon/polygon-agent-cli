import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

async function freshMode(home: string) {
  vi.resetModules();
  vi.stubEnv('HOME', home);
  return await import('./mode.ts');
}

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pa-mode-'));
}

describe('tx mode persistence', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('defaults to dry-run when no config file exists', async () => {
    const mode = await freshMode(tmpHome());
    expect(mode.loadTxMode()).toBe('dry-run');
    expect(mode.isTxModeSet()).toBe(false);
  });

  it('round-trips saveTxMode/loadTxMode and marks the mode as set', async () => {
    const mode = await freshMode(tmpHome());
    mode.saveTxMode('auto');
    expect(mode.loadTxMode()).toBe('auto');
    expect(mode.isTxModeSet()).toBe(true);
    mode.saveTxMode('dry-run');
    expect(mode.loadTxMode()).toBe('dry-run');
    expect(mode.isTxModeSet()).toBe(true);
  });

  it('preserves unrelated keys already in config.json', async () => {
    const home = tmpHome();
    fs.mkdirSync(path.join(home, '.polygon-agent'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.polygon-agent', 'config.json'),
      JSON.stringify({ other: 'keep' })
    );
    const mode = await freshMode(home);
    mode.saveTxMode('auto');
    const data = JSON.parse(
      fs.readFileSync(path.join(home, '.polygon-agent', 'config.json'), 'utf8')
    );
    expect(data).toEqual({ other: 'keep', mode: 'auto' });
  });

  it('treats an invalid stored mode as dry-run and not set', async () => {
    const home = tmpHome();
    fs.mkdirSync(path.join(home, '.polygon-agent'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.polygon-agent', 'config.json'),
      JSON.stringify({ mode: 'yolo' })
    );
    const mode = await freshMode(home);
    expect(mode.loadTxMode()).toBe('dry-run');
    expect(mode.isTxModeSet()).toBe(false);
  });
});

describe('resolveBroadcast precedence', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('--dry-run always wins, even over --broadcast and auto mode', async () => {
    const mode = await freshMode(tmpHome());
    mode.saveTxMode('auto');
    expect(mode.resolveBroadcast({ dryRun: true, broadcast: true })).toBe(false);
    expect(mode.resolveBroadcast({ dryRun: true })).toBe(false);
  });

  it('explicit --broadcast / --no-broadcast beats the persisted mode', async () => {
    const mode = await freshMode(tmpHome());
    expect(mode.resolveBroadcast({ broadcast: true })).toBe(true);
    mode.saveTxMode('auto');
    expect(mode.resolveBroadcast({ broadcast: false })).toBe(false);
  });

  it('falls back to the persisted mode when no flag is passed', async () => {
    const mode = await freshMode(tmpHome());
    expect(mode.resolveBroadcast({})).toBe(false);
    mode.saveTxMode('auto');
    expect(mode.resolveBroadcast({})).toBe(true);
  });
});

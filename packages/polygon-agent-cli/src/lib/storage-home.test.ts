import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('POLYGON_AGENT_HOME', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('moves all state, including config.json, into the given folder', async () => {
    const home = tmpDir('pa-home-');
    const state = path.join(tmpDir('pa-ws-'), 'state');
    vi.stubEnv('HOME', home);
    vi.stubEnv('POLYGON_AGENT_HOME', state);
    vi.resetModules();

    const storage = await import('./storage.ts');
    const mode = await import('./mode.ts');
    expect(storage.STORAGE_ROOT).toBe(state);

    mode.saveTxMode('auto');
    storage.getEncryptionKey();
    expect(JSON.parse(fs.readFileSync(path.join(state, 'config.json'), 'utf8'))).toEqual({
      mode: 'auto'
    });
    expect(fs.existsSync(path.join(state, '.encryption-key'))).toBe(true);
    expect(fs.statSync(state).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(path.join(home, '.polygon-agent'))).toBe(false);
  });

  it('resolves a relative path against the working directory', async () => {
    vi.stubEnv('POLYGON_AGENT_HOME', 'some/state');
    vi.resetModules();
    const storage = await import('./storage.ts');
    expect(storage.STORAGE_ROOT).toBe(path.resolve('some/state'));
  });

  it('defaults to ~/.polygon-agent when unset or empty', async () => {
    const home = tmpDir('pa-home-');
    vi.stubEnv('HOME', home);
    vi.stubEnv('POLYGON_AGENT_HOME', '');
    vi.resetModules();
    const storage = await import('./storage.ts');
    expect(storage.STORAGE_ROOT).toBe(path.join(home, '.polygon-agent'));
  });
});

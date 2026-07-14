import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

async function freshStorage(home: string) {
  vi.resetModules();
  vi.stubEnv('HOME', home);
  return await import('./storage.ts');
}

describe('loadOmsConfig resolution order', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('falls back to the baked-in default when neither env nor file exist', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-home-'));
    vi.stubEnv('SEQUENCE_PUBLISHABLE_KEY', '');
    const storage = await freshStorage(home);
    const cfg = storage.loadOmsConfig();
    expect(cfg.publishableKey).toBe(storage.DEFAULT_SEQUENCE_PUBLISHABLE_KEY);
    expect(cfg.publishableKey.startsWith('pk_')).toBe(true);
  });

  it('prefers builder.json over the default', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-home-'));
    fs.mkdirSync(path.join(home, '.polygon-agent'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.polygon-agent', 'builder.json'),
      JSON.stringify({ publishableKey: 'pk_test_fromfile' })
    );
    vi.stubEnv('SEQUENCE_PUBLISHABLE_KEY', '');
    const storage = await freshStorage(home);
    expect(storage.loadOmsConfig().publishableKey).toBe('pk_test_fromfile');
  });

  it('prefers the env var over everything', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-home-'));
    vi.stubEnv('SEQUENCE_PUBLISHABLE_KEY', 'pk_test_fromenv');
    const storage = await freshStorage(home);
    expect(storage.loadOmsConfig().publishableKey).toBe('pk_test_fromenv');
  });
});

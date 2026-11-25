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
    vi.stubEnv('OMS_PUBLISHABLE_KEY', '');
    const storage = await freshStorage(home);
    const cfg = storage.loadOmsConfig();
    expect(cfg.publishableKey).toBe(storage.DEFAULT_OMS_PUBLISHABLE_KEY);
    expect(cfg.publishableKey.startsWith('pk_')).toBe(true);
  });

  it('prefers builder.json over the default', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-home-'));
    fs.mkdirSync(path.join(home, '.polygon-agent'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.polygon-agent', 'builder.json'),
      JSON.stringify({ publishableKey: 'pk_test_fromfile' })
    );
    vi.stubEnv('OMS_PUBLISHABLE_KEY', '');
    const storage = await freshStorage(home);
    expect(storage.loadOmsConfig().publishableKey).toBe('pk_test_fromfile');
  });

  it('prefers the env var over everything', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-home-'));
    vi.stubEnv('OMS_PUBLISHABLE_KEY', 'pk_test_fromenv');
    const storage = await freshStorage(home);
    expect(storage.loadOmsConfig().publishableKey).toBe('pk_test_fromenv');
  });
});

describe('saveBuilderConfig merging', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('merges new fields into builder.json instead of clobbering it', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-home-'));
    const configDir = path.join(home, '.polygon-agent');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'builder.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ publishableKey: 'pk_test_keep', polymarketPrivateKey: 'enc_keep' })
    );

    const storage = await freshStorage(home);
    await storage.saveBuilderConfig({
      privateKey: '0xabc',
      eoaAddress: '0x1',
      accessKey: 'AQ_new',
      projectId: 7
    });

    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(data.publishableKey).toBe('pk_test_keep');
    expect(data.polymarketPrivateKey).toBe('enc_keep');
    expect(data.accessKey).toBe('AQ_new');
    expect(data.projectId).toBe(7);
  });

  it('loadBuilderConfigRaw reads the accessKey without decrypting, and is null-safe', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-home-'));
    const configDir = path.join(home, '.polygon-agent');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'builder.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ publishableKey: 'pk_test_keep', polymarketPrivateKey: 'enc_keep' })
    );

    const storage = await freshStorage(home);
    await storage.saveBuilderConfig({
      privateKey: '0xabc',
      eoaAddress: '0x1',
      accessKey: 'AQ_new',
      projectId: 7
    });
    expect(storage.loadBuilderConfigRaw()).toEqual({ accessKey: 'AQ_new' });

    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-home-'));
    const emptyStorage = await freshStorage(emptyHome);
    expect(emptyStorage.loadBuilderConfigRaw()).toBeNull();
  });
});

describe('resolveProjectAccessKey', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  function writeBuilder(home: string, data: Record<string, unknown>) {
    fs.mkdirSync(path.join(home, '.polygon-agent'), { recursive: true });
    fs.writeFileSync(path.join(home, '.polygon-agent', 'builder.json'), JSON.stringify(data));
  }

  it('uses the builder.json key for the node gateway when env has none', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-home-'));
    writeBuilder(home, { accessKey: 'ak-file' });
    vi.stubEnv('SEQUENCE_PROJECT_ACCESS_KEY', '');
    const storage = await freshStorage(home);
    const utils = await import('./utils.ts');
    expect(storage.resolveProjectAccessKey()).toBe('ak-file');
    expect(utils.getRpcUrl(utils.resolveNetwork('polygon'))).toBe(
      'https://nodes.sequence.app/polygon/ak-file'
    );
    expect(utils.getReadRpcUrl(utils.resolveNetwork('polygon'))).toBe(
      'https://nodes.sequence.app/polygon/ak-file'
    );
  });

  it('prefers the env var over builder.json', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-home-'));
    writeBuilder(home, { accessKey: 'ak-file' });
    vi.stubEnv('SEQUENCE_PROJECT_ACCESS_KEY', 'ak-env');
    const storage = await freshStorage(home);
    const utils = await import('./utils.ts');
    expect(storage.resolveProjectAccessKey()).toBe('ak-env');
    expect(utils.getReadRpcUrl(utils.resolveNetwork('polygon'))).toBe(
      'https://nodes.sequence.app/polygon/ak-env'
    );
  });

  it('picks up a key written to builder.json during the run', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-home-'));
    vi.stubEnv('SEQUENCE_PROJECT_ACCESS_KEY', '');
    const storage = await freshStorage(home);
    expect(storage.resolveProjectAccessKey()).toBeUndefined();
    writeBuilder(home, { accessKey: 'ak-later' });
    expect(storage.resolveProjectAccessKey()).toBe('ak-later');
  });
});

describe('loadOmsConfig project id', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('prefers the env project id over builder.json, as with the key', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-home-'));
    fs.mkdirSync(path.join(home, '.polygon-agent'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.polygon-agent', 'builder.json'),
      JSON.stringify({ publishableKey: 'pk_test_fromfile', omsProjectId: 'proj-file' })
    );
    vi.stubEnv('OMS_PUBLISHABLE_KEY', '');
    vi.stubEnv('SEQUENCE_OMS_PROJECT_ID', 'proj-env');
    const storage = await freshStorage(home);
    expect(storage.loadOmsConfig()).toEqual({
      publishableKey: 'pk_test_fromfile',
      omsProjectId: 'proj-env'
    });
  });

  it('falls back to the builder.json project id when env has none', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-home-'));
    fs.mkdirSync(path.join(home, '.polygon-agent'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.polygon-agent', 'builder.json'),
      JSON.stringify({ publishableKey: 'pk_test_fromfile', omsProjectId: 'proj-file' })
    );
    vi.stubEnv('OMS_PUBLISHABLE_KEY', '');
    vi.stubEnv('SEQUENCE_OMS_PROJECT_ID', '');
    const storage = await freshStorage(home);
    expect(storage.loadOmsConfig().omsProjectId).toBe('proj-file');
  });
});

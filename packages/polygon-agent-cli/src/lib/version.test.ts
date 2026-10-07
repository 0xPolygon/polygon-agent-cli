import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cliVersion, isNewerVersion } from './version.ts';

describe('isNewerVersion', () => {
  it.each([
    ['0.15.0', '0.14.0', true],
    ['0.14.1', '0.14.0', true],
    ['1.0.0', '0.99.99', true],
    ['0.14.0', '0.14.0', false],
    ['0.13.9', '0.14.0', false],
    ['0.14.10', '0.14.9', true],
    ['0.14.0', '0.14.0-beta.1', true],
    ['0.14.0-beta.1', '0.14.0', false],
    ['0.14.0-beta.2', '0.14.0-beta.1', true],
    ['latest', '0.14.0', false],
    ['0.15.0', 'dev', false]
  ])('%s newer than %s: %s', (candidate, current, expected) => {
    expect(isNewerVersion({ candidate, current })).toBe(expected);
  });
});

describe('cliVersion', () => {
  it("reads this package's version", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'package.json'), 'utf8')
    );
    expect(cliVersion()).toBe(pkg.version);
  });
});

describe('getLatestVersion', () => {
  let state: string;

  beforeEach(() => {
    state = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-version-'));
    vi.stubEnv('POLYGON_AGENT_HOME', state);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  function stubRegistry(response: () => Promise<Response>) {
    const fetchMock = vi.fn(response);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('fetches, caches, and serves from the cache within maxAge', async () => {
    const fetchMock = stubRegistry(async () => Response.json({ version: '9.9.9' }));
    const { getLatestVersion } = await import('./version.ts');

    expect(await getLatestVersion()).toBe('9.9.9');
    expect(await getLatestVersion()).toBe('9.9.9');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const config = JSON.parse(fs.readFileSync(path.join(state, 'config.json'), 'utf8'));
    expect(config.latestVersion.version).toBe('9.9.9');
  });

  it('refetches when maxAgeMs is 0', async () => {
    const fetchMock = stubRegistry(async () => Response.json({ version: '9.9.9' }));
    const { getLatestVersion } = await import('./version.ts');
    await getLatestVersion();
    await getLatestVersion({ maxAgeMs: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to the cached value, then null, when the registry fails', async () => {
    fs.writeFileSync(
      path.join(state, 'config.json'),
      JSON.stringify({ latestVersion: { version: '1.2.3', checkedAt: 0 } })
    );
    stubRegistry(async () => new Response('nope', { status: 503 }));
    const { getLatestVersion } = await import('./version.ts');
    expect(await getLatestVersion()).toBe('1.2.3');

    fs.writeFileSync(path.join(state, 'config.json'), '{}');
    expect(await getLatestVersion()).toBeNull();
  });

  it('rejects a malformed registry answer', async () => {
    stubRegistry(async () => Response.json({ name: 'x' }));
    const { getLatestVersion } = await import('./version.ts');
    expect(await getLatestVersion()).toBeNull();
  });
});

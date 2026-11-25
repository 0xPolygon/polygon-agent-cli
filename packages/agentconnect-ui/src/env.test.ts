import { afterEach, describe, expect, it, vi } from 'vitest';

// getEnv memoises, so each test loads a fresh module after stubbing.
async function load() {
  vi.resetModules();
  return (await import('./env')).getEnv();
}

const RELAY_DEFAULT = 'https://oidc-relay.polygon.technology';

describe('getEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('works with nothing set, defaulting the relay URL', async () => {
    vi.stubEnv('VITE_OIDC_RELAY_URL', '');
    const env = await load();
    expect(env.VITE_OIDC_RELAY_URL).toBe(RELAY_DEFAULT);
    expect(env.VITE_INDEXER_URL).toBeUndefined();
    expect(env.VITE_TRAILS_API_KEY).toBeUndefined();
  });

  it('treats empty strings as unset', async () => {
    vi.stubEnv('VITE_OIDC_RELAY_URL', '');
    vi.stubEnv('VITE_INDEXER_URL', '');
    vi.stubEnv('VITE_INDEXER_ACCESS_KEY', '');
    const env = await load();
    expect(env.VITE_OIDC_RELAY_URL).toBe(RELAY_DEFAULT);
    expect(env.VITE_INDEXER_URL).toBeUndefined();
    expect(env.VITE_INDEXER_ACCESS_KEY).toBeUndefined();
  });

  it('passes through set values', async () => {
    vi.stubEnv('VITE_OIDC_RELAY_URL', 'https://relay.example.com');
    vi.stubEnv('VITE_INDEXER_URL', 'https://indexer.example.com/rpc');
    vi.stubEnv('VITE_PROJECT_ACCESS_KEY', 'proj');
    const env = await load();
    expect(env.VITE_OIDC_RELAY_URL).toBe('https://relay.example.com');
    expect(env.VITE_INDEXER_URL).toBe('https://indexer.example.com/rpc');
    expect(env.VITE_PROJECT_ACCESS_KEY).toBe('proj');
  });

  it('rejects a malformed URL', async () => {
    vi.stubEnv('VITE_INDEXER_URL', 'not a url');
    await expect(load()).rejects.toThrow();
  });
});

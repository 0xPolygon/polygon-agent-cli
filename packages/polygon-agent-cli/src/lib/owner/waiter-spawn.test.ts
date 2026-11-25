// spawnWaiter hands the run's --relay-url to the waiter process through its environment.

import type * as ChildProcess from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

const child = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: child.spawn
}));

const { spawnWaiter } = await import('./waiter.ts');

afterEach(() => {
  child.spawn.mockReset();
  vi.unstubAllEnvs();
});

describe('spawnWaiter', () => {
  it('puts the relay url in the child env without touching this process', () => {
    vi.stubEnv('POLYGON_AGENT_OIDC_RELAY', '');
    child.spawn.mockReturnValue({ unref: () => {}, pid: undefined });
    spawnWaiter({ wallet: 'w', id: 'r', relayUrl: 'https://relay.example' });
    const env = child.spawn.mock.calls[0]?.[2]?.env;
    expect(env.POLYGON_AGENT_OIDC_RELAY).toBe('https://relay.example');
    expect(process.env.POLYGON_AGENT_OIDC_RELAY).toBe('');
  });

  it('passes the environment through unchanged without a relay url', () => {
    vi.stubEnv('POLYGON_AGENT_OIDC_RELAY', 'https://from-env.example');
    child.spawn.mockReturnValue({ unref: () => {}, pid: undefined });
    spawnWaiter({ wallet: 'w', id: 'r' });
    expect(child.spawn.mock.calls[0]?.[2]?.env.POLYGON_AGENT_OIDC_RELAY).toBe(
      'https://from-env.example'
    );
  });
});

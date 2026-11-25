import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetEnv } from './env.ts';
import { getReadRpcUrl, resolveNetwork } from './utils.ts';

beforeEach(() => {
  // An empty state folder, so a developer's real builder.json never supplies a key.
  vi.stubEnv('POLYGON_AGENT_HOME', fs.mkdtempSync(path.join(os.tmpdir(), 'pa-utils-')));
  resetEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnv();
});

describe('getReadRpcUrl', () => {
  it('uses the node gateway when a project access key is set', () => {
    vi.stubEnv('SEQUENCE_PROJECT_ACCESS_KEY', 'ak-test');
    resetEnv();
    expect(getReadRpcUrl(resolveNetwork(137))).toBe('https://nodes.sequence.app/polygon/ak-test');
  });

  it('uses the node gateway for a chain with no public fallback when a key is set', () => {
    vi.stubEnv('SEQUENCE_PROJECT_ACCESS_KEY', 'ak-test');
    resetEnv();
    const network = resolveNetwork(56);
    expect(getReadRpcUrl(network)).toBe(`https://nodes.sequence.app/${network.name}/ak-test`);
  });

  it.each([
    [137, 'https://polygon-bor-rpc.publicnode.com'],
    [80002, 'https://polygon-amoy-bor-rpc.publicnode.com'],
    [1, 'https://ethereum-rpc.publicnode.com'],
    [8453, 'https://base-rpc.publicnode.com'],
    [84532, 'https://base-sepolia-rpc.publicnode.com'],
    [42161, 'https://arbitrum-one-rpc.publicnode.com'],
    [10, 'https://optimism-rpc.publicnode.com']
  ])('falls back to a public RPC for chain %i without a key', (chainId, url) => {
    vi.stubEnv('SEQUENCE_PROJECT_ACCESS_KEY', '');
    resetEnv();
    expect(getReadRpcUrl(resolveNetwork(chainId))).toBe(url);
  });

  it('refuses a chain with no public fallback instead of reading another chain', () => {
    vi.stubEnv('SEQUENCE_PROJECT_ACCESS_KEY', '');
    resetEnv();
    expect(() => getReadRpcUrl(resolveNetwork(56))).toThrow(
      /chain 56.*SEQUENCE_PROJECT_ACCESS_KEY/
    );
  });
});

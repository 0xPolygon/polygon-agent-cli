// Two first uses at once must not each create a signer and overwrite the
// other's saved key (one may already have funded its signer).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ProvisionDeps } from './builder-provision.ts';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-provision-'));

const { provisionBuilderOnce } = await import('./builder-provision.ts');

describe('provisionBuilderOnce', () => {
  it('provisions once when two callers race, and the second sees the saved key', async () => {
    let stored: { accessKey: string; privateKey: string } | null = null;
    let created = 0;
    const deps: ProvisionDeps = {
      loadBuilderConfig: async () => stored,
      saveBuilderConfig: async (cfg) => {
        stored = { accessKey: cfg.accessKey, privateKey: cfg.privateKey };
      },
      createEoa: () => {
        created += 1;
        return { privateKey: `0xkey${created}`, address: `0x${String(created).padStart(40, '0')}` };
      },
      generateProof: async () => 'proof',
      getAuthToken: async () => 'jwt',
      // Slow, so without the lock both callers would get this far.
      createProject: (name) => new Promise((r) => setTimeout(() => r({ id: 1, name }), 50)),
      getDefaultAccessKey: async () => 'access-key'
    };
    const results = await Promise.all([
      provisionBuilderOnce({ walletAddress: '0xc2F4cAfe89AE7e1bcB86dd3f141C0a3adCEB6C17', deps }),
      provisionBuilderOnce({ walletAddress: '0xc2F4cAfe89AE7e1bcB86dd3f141C0a3adCEB6C17', deps })
    ]);
    expect(created).toBe(1);
    expect(results.map((r) => r.reason ?? 'provisioned').sort()).toEqual([
      'existing',
      'provisioned'
    ]);
    expect(stored).toMatchObject({ privateKey: '0xkey1' });
  });
});

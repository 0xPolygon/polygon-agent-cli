import { describe, expect, it } from 'vitest';

import type { ProvisionDeps } from './builder-provision.ts';

import { ensureBuilderAccessKey } from './builder-provision.ts';

function makeFakes(overrides: Partial<ProvisionDeps> = {}) {
  const saved: unknown[] = [];
  const deps: ProvisionDeps = {
    loadBuilderConfig: async () => null,
    saveBuilderConfig: async (cfg) => {
      saved.push(cfg);
    },
    createEoa: () => ({
      privateKey: '0xkey',
      address: '0xE0A0000000000000000000000000000000000001'
    }),
    generateProof: async () => 'eth.proof',
    getAuthToken: async () => 'jwt-1',
    createProject: async (name) => ({ id: 4242, name }),
    getDefaultAccessKey: async () => 'AQAAAA-access-key',
    ...overrides
  };
  return { deps, saved };
}

const WALLET = '0xc2F4cAfe89AE7e1bcB86dd3f141C0a3adCEB6C17';

describe('ensureBuilderAccessKey', () => {
  it('provisions a project and saves the credentials', async () => {
    const { deps, saved } = makeFakes();
    const result = await ensureBuilderAccessKey(WALLET, deps);
    expect(result).toEqual({ provisioned: true });
    expect(saved).toEqual([
      {
        privateKey: '0xkey',
        eoaAddress: '0xE0A0000000000000000000000000000000000001',
        accessKey: 'AQAAAA-access-key',
        projectId: 4242
      }
    ]);
  });

  it('derives the project name from the wallet address', async () => {
    let projectName = '';
    const { deps } = makeFakes({
      createProject: async (name) => {
        projectName = name;
        return { id: 1, name };
      }
    });
    await ensureBuilderAccessKey(WALLET, deps);
    expect(projectName).toBe('polygon-agent-c2f4cafe');
  });

  it('short-circuits when an access key already exists', async () => {
    const { deps, saved } = makeFakes({
      loadBuilderConfig: async () =>
        ({ accessKey: 'existing', projectId: 1, privateKey: 'x', eoaAddress: '0x1' }) as never
    });
    const result = await ensureBuilderAccessKey(WALLET, deps);
    expect(result).toEqual({ provisioned: false, reason: 'existing' });
    expect(saved).toEqual([]);
  });

  it('reports the failing stage without throwing', async () => {
    const { deps: authFail } = makeFakes({
      getAuthToken: async () => {
        throw new Error('GetAuthToken failed: 500');
      }
    });
    await expect(ensureBuilderAccessKey(WALLET, authFail)).resolves.toEqual({
      provisioned: false,
      reason: 'auth: GetAuthToken failed: 500'
    });

    const { deps: projectFail, saved } = makeFakes({
      createProject: async () => {
        throw new Error('CreateProject failed: 403');
      }
    });
    await expect(ensureBuilderAccessKey(WALLET, projectFail)).resolves.toEqual({
      provisioned: false,
      reason: 'project: CreateProject failed: 403'
    });
    expect(saved).toEqual([]);
  });

  it('catches a throwing createEoa without rejecting', async () => {
    const { deps } = makeFakes({
      createEoa: () => {
        throw new Error('entropy unavailable');
      }
    });
    await expect(ensureBuilderAccessKey(WALLET, deps)).resolves.toEqual({
      provisioned: false,
      reason: 'eoa: entropy unavailable'
    });
  });

  it('reports the access-key stage failure without throwing, and saves nothing', async () => {
    const { deps, saved } = makeFakes({
      getDefaultAccessKey: async () => {
        throw new Error('GetDefaultAccessKey failed: 500');
      }
    });
    await expect(ensureBuilderAccessKey(WALLET, deps)).resolves.toEqual({
      provisioned: false,
      reason: 'access-key: GetDefaultAccessKey failed: 500'
    });
    expect(saved).toEqual([]);
  });

  it('normalizes a non-Error throw to its string form', async () => {
    const { deps } = makeFakes({
      getAuthToken: async () => {
        throw 'boom';
      }
    });
    await expect(ensureBuilderAccessKey(WALLET, deps)).resolves.toEqual({
      provisioned: false,
      reason: 'auth: boom'
    });
  });
});

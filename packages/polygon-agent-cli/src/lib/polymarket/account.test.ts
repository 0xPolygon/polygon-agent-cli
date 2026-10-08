import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SdkModule from './sdk.ts';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-pm-account-'));

const sdk = vi.hoisted(() => {
  const created: Array<Record<string, unknown>> = [];
  const client = (wallet: string) => ({
    account: { signer: '0x1111111111111111111111111111111111111111', wallet, walletType: 3 },
    credentials: { key: 'clob-key', secret: 'clob-secret', passphrase: 'clob-pass' },
    fetchTradingApprovalsState: vi.fn(async () => ({ isFullyApproved: false, missing: {} })),
    setupTradingApprovals: vi.fn(async () => undefined)
  });
  return {
    created,
    createSecureClient: vi.fn(async (opts: Record<string, unknown>) => {
      created.push(opts);
      return client((opts.wallet as string) ?? '0xD0000000000000000000000000000000000000D0');
    }),
    createBuilderApiKey: vi.fn(async () => ({
      key: 'b-key',
      secret: 'b-secret',
      passphrase: 'b-pass'
    })),
    updateBalanceAllowance: vi.fn(async () => ({ balance: '2500000', allowances: {} }))
  };
});

vi.mock('./sdk.ts', async (orig) => ({
  ...(await orig<typeof SdkModule>()),
  loadSdk: async () => ({
    root: { createSecureClient: sdk.createSecureClient, AssetType: { COLLATERAL: 'COLLATERAL' } },
    viem: { privateKey: (k: string) => ({ __pk: k }) },
    node: { builderApiKey: (c: unknown) => ({ __builder: c }) },
    actions: {
      createBuilderApiKey: sdk.createBuilderApiKey,
      updateBalanceAllowance: sdk.updateBalanceAllowance
    }
  })
}));

const account = await import('./account.ts');

beforeEach(() => {
  sdk.created.length = 0;
  vi.clearAllMocks();
  fs.rmSync(path.join(String(process.env.POLYGON_AGENT_HOME), 'polymarket'), {
    recursive: true,
    force: true
  });
});

describe('setupAccount', () => {
  it('creates a key, mints a builder key as the EOA, then deploys the deposit wallet and sets approvals', async () => {
    const res = await account.setupAccount('main');
    expect(res.created).toBe(true);
    expect(res.approvalsSet).toBe(true);
    // first client: EOA mode (wallet = signer) to mint the builder key
    expect(sdk.created[0].wallet).toBe(res.account.signer);
    // second client: deposit wallet (no wallet option) with the builder key
    expect(sdk.created[1].wallet).toBeUndefined();
    expect(sdk.created[1].apiKey).toEqual({
      __builder: { key: 'b-key', secret: 'b-secret', passphrase: 'b-pass' }
    });
    expect(res.account).toMatchObject({
      kind: 'deposit-wallet',
      wallet: '0xD0000000000000000000000000000000000000D0'
    });
  });

  it('is idempotent: a second run reuses the key and builder key', async () => {
    await account.setupAccount('main');
    sdk.created.length = 0;
    const res = await account.setupAccount('main');
    expect(res.created).toBe(false);
    expect(sdk.createBuilderApiKey).toHaveBeenCalledTimes(1);
    expect(sdk.created).toHaveLength(1);
  });

  it('never writes the private key or builder secret in plaintext', async () => {
    await account.setupAccount('main');
    const dir = account.accountDir('main');
    for (const f of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(text).not.toMatch(/b-secret|clob-secret/);
      expect(text).not.toMatch(/"0x[0-9a-f]{64}"/i);
    }
  });
});

describe('requireAccount / getTradingClient', () => {
  it('fails with not_set_up and a command hint for a wallet without setup', async () => {
    expect(() => account.requireAccount('other')).toThrow(
      expect.objectContaining({
        code: 'not_set_up',
        command: 'agent polymarket setup --wallet other --broadcast'
      })
    );
    await expect(account.getTradingClient('other')).rejects.toMatchObject({ code: 'not_set_up' });
    expect(sdk.created).toHaveLength(0);
  });

  it('reuses stored CLOB credentials', async () => {
    await account.setupAccount('main');
    sdk.created.length = 0;
    await account.getTradingClient('main');
    expect(sdk.created[0].credentials).toEqual({
      key: 'clob-key',
      secret: 'clob-secret',
      passphrase: 'clob-pass'
    });
  });
});

describe('pusdBalance', () => {
  it('refreshes and reads the collateral balance in base units', async () => {
    await account.setupAccount('main');
    expect(await account.pusdBalance('main')).toBe(2_500_000n);
    expect(sdk.updateBalanceAllowance).toHaveBeenCalledWith(expect.anything(), {
      assetType: 'COLLATERAL'
    });
  });
});

describe('importLegacyKey', () => {
  const pk = `0x${'ab'.repeat(32)}`;

  it('refuses to overwrite an existing account and writes nothing', async () => {
    await account.setupAccount('main');
    const keyFile = path.join(account.accountDir('main'), 'key.json');
    const before = fs.readFileSync(keyFile);
    await expect(account.importLegacyKey('main', pk)).rejects.toMatchObject({
      code: 'invalid_input'
    });
    expect(fs.readFileSync(keyFile).equals(before)).toBe(true);
  });

  it('leaves no builder or clob credentials after a fresh import', async () => {
    fs.mkdirSync(account.accountDir('legacy'), { recursive: true });
    fs.writeFileSync(path.join(account.accountDir('legacy'), 'builder.json'), '{}');
    fs.writeFileSync(path.join(account.accountDir('legacy'), 'clob.json'), '{}');
    await account.importLegacyKey('legacy', pk);
    const files = fs.readdirSync(account.accountDir('legacy')).sort();
    expect(files).toEqual(['account.json', 'key.json']);
  });
});

describe('setupAccount with a missing key', () => {
  it('fails with not_set_up and does not generate a new key', async () => {
    await account.setupAccount('main');
    const dir = account.accountDir('main');
    fs.rmSync(path.join(dir, 'key.json'));
    await expect(account.setupAccount('main')).rejects.toMatchObject({ code: 'not_set_up' });
    expect(fs.existsSync(path.join(dir, 'key.json'))).toBe(false);
  });
});

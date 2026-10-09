import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SdkModule from './sdk.ts';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-pm-account-'));

const sdk = vi.hoisted(() => {
  const clientApprovals = { isFullyApproved: false };
  const created: Array<Record<string, unknown>> = [];
  const client = (wallet: string) => ({
    account: { signer: '0x1111111111111111111111111111111111111111', wallet, walletType: 3 },
    credentials: { key: 'clob-key', secret: 'clob-secret', passphrase: 'clob-pass' },
    fetchTradingApprovalsState: vi.fn(async () => ({
      isFullyApproved: sdk.clientApprovals.isFullyApproved,
      missing: {}
    })),
    setupTradingApprovals: vi.fn(async () => undefined),
    approveErc20: vi.fn(async () => ({ wait: async () => ({ transactionHash: '0xa' }) })),
    approveErc1155ForAll: vi.fn(async () => ({ wait: async () => ({ transactionHash: '0xb' }) }))
  });
  const chain = { allowance: 0n, approved: false, fail: null as Error | null };
  const reads: Array<Record<string, unknown>> = [];
  return {
    created,
    chain,
    reads,
    clientApprovals,
    clients: [] as Array<ReturnType<typeof client>>,
    createSecureClient: vi.fn(async (opts: Record<string, unknown>) => {
      created.push(opts);
      const c = client((opts.wallet as string) ?? '0xD0000000000000000000000000000000000000D0');
      sdk.clients.push(c);
      return c;
    }),
    createBuilderApiKey: vi.fn(async () => ({
      key: 'b-key',
      secret: 'b-secret',
      passphrase: 'b-pass'
    })),
    updateBalanceAllowance: vi.fn(async () => ({ balance: '2500000', allowances: {} }))
  };
});

vi.mock('viem', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createPublicClient: () => ({
    readContract: async (req: { functionName: string }) => {
      sdk.reads.push(req);
      if (sdk.chain.fail) throw sdk.chain.fail;
      return req.functionName === 'allowance' ? sdk.chain.allowance : sdk.chain.approved;
    }
  })
}));

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
  sdk.clients.length = 0;
  sdk.chain.allowance = 0n;
  sdk.chain.approved = false;
  sdk.chain.fail = null;
  sdk.reads.length = 0;
  sdk.clientApprovals.isFullyApproved = false;
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

describe('legacy NegRiskAdapter approvals', () => {
  const ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
  const MAX = 2n ** 256n - 1n;

  it('sets both on a fresh account and refreshes the CLOB cache', async () => {
    const res = await account.setupAccount('main');
    const c = sdk.clients.at(-1)!;
    expect(res.approvalsSet).toBe(true);
    expect(c.approveErc20).toHaveBeenCalledWith({
      amount: 'max',
      spenderAddress: ADAPTER,
      tokenAddress: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'
    });
    expect(c.approveErc1155ForAll).toHaveBeenCalledWith({
      operatorAddress: ADAPTER,
      tokenAddress: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'
    });
    expect(sdk.updateBalanceAllowance).toHaveBeenCalledWith(c, { assetType: 'COLLATERAL' });
  });

  it('sets nothing on a rerun when both are present', async () => {
    await account.setupAccount('main');
    sdk.chain.allowance = MAX;
    sdk.chain.approved = true;
    sdk.updateBalanceAllowance.mockClear();
    sdk.clientApprovals.isFullyApproved = true;
    const res = await account.setupAccount('main');
    const c = sdk.clients.at(-1)!;
    expect(c.approveErc20).not.toHaveBeenCalled();
    expect(c.approveErc1155ForAll).not.toHaveBeenCalled();
    expect(res.approvalsSet).toBe(false);
    expect(sdk.updateBalanceAllowance).not.toHaveBeenCalled();
  });

  it('sets only what is missing', async () => {
    await account.setupAccount('main');
    sdk.chain.allowance = MAX;
    sdk.chain.approved = false;
    const c = sdk.clients.at(-1)!;
    c.approveErc20.mockClear();
    c.approveErc1155ForAll.mockClear();
    expect(await account.ensureLegacyNegRiskApprovals(c)).toBe(true);
    expect(c.approveErc20).not.toHaveBeenCalled();
    expect(c.approveErc1155ForAll).toHaveBeenCalledTimes(1);
  });

  it('reads the pUSD allowance and CTF approval for the wallet and adapter', async () => {
    await account.setupAccount('main');
    const wallet = '0xD0000000000000000000000000000000000000D0';
    expect(sdk.reads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          address: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
          functionName: 'allowance',
          args: [wallet, ADAPTER]
        }),
        expect.objectContaining({
          address: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
          functionName: 'isApprovedForAll',
          args: [wallet, ADAPTER]
        })
      ])
    );
  });

  it('fails with upstream_unavailable and sends no approval when the read fails', async () => {
    sdk.chain.fail = new Error('HTTP request failed');
    await expect(account.setupAccount('main')).rejects.toMatchObject({
      code: 'upstream_unavailable'
    });
    const c = sdk.clients.at(-1)!;
    expect(c.approveErc20).not.toHaveBeenCalled();
    expect(c.approveErc1155ForAll).not.toHaveBeenCalled();
  });

  it('maps a 429 read to rate_limited', async () => {
    sdk.chain.fail = Object.assign(new Error('Too many requests'), { status: 429 });
    await expect(account.setupAccount('main')).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('legacyNegRiskApproved needs both', async () => {
    await account.setupAccount('main');
    const c = sdk.clients.at(-1)!;
    sdk.chain.allowance = MAX;
    expect(await account.legacyNegRiskApproved(c)).toBe(false);
    sdk.chain.approved = true;
    expect(await account.legacyNegRiskApproved(c)).toBe(true);
  });
});

describe('read paths', () => {
  it('loadAccount for a wallet without an account creates no directory', () => {
    expect(account.loadAccount('ghost')).toBeNull();
    expect(
      fs.existsSync(path.join(String(process.env.POLYGON_AGENT_HOME), 'polymarket', 'ghost'))
    ).toBe(false);
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

  it('replaces stale credentials with a builder key minted as the imported EOA', async () => {
    fs.mkdirSync(account.accountDir('legacy'), { recursive: true });
    fs.writeFileSync(path.join(account.accountDir('legacy'), 'builder.json'), '{}');
    fs.writeFileSync(path.join(account.accountDir('legacy'), 'clob.json'), '{}');
    const res = await account.importLegacyKey('legacy', pk);
    expect(res.builderKey).toBe(true);
    expect(res.warning).toBeUndefined();
    expect(res.account.kind).toBe('legacy-proxy');
    // EOA mode: the signer is its own wallet, as in setup.
    expect(sdk.created[0]).toMatchObject({ signer: { __pk: pk }, wallet: res.account.signer });
    expect(sdk.createBuilderApiKey).toHaveBeenCalledTimes(1);
    const files = fs.readdirSync(account.accountDir('legacy')).sort();
    expect(files).toEqual(['account.json', 'builder.json', 'key.json']);
    const builder = JSON.parse(
      fs.readFileSync(path.join(account.accountDir('legacy'), 'builder.json'), 'utf8')
    );
    expect(JSON.stringify(builder)).not.toMatch(/b-secret/);
    const { decrypt } = await import('../storage.ts');
    expect(JSON.parse(decrypt(builder))).toEqual({
      key: 'b-key',
      secret: 'b-secret',
      passphrase: 'b-pass'
    });
  });

  it('still imports when minting the builder key fails, with a warning about withdraw', async () => {
    sdk.createBuilderApiKey.mockRejectedValueOnce(new Error('relayer down'));
    const res = await account.importLegacyKey('legacy2', pk);
    expect(res.builderKey).toBe(false);
    expect(res.warning).toMatch(/relayer down/);
    expect(res.warning).toMatch(/withdraw/);
    expect(res.warning).toMatch(/agent polymarket setup --wallet legacy2 --broadcast/);
    expect(account.loadAccount('legacy2')).toMatchObject({ kind: 'legacy-proxy' });
    const files = fs.readdirSync(account.accountDir('legacy2')).sort();
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

describe('ensureTradingKey and backup record', () => {
  it('generates once, reuses the key, and deploys nothing', async () => {
    const first = await account.ensureTradingKey('main');
    expect(first).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await account.ensureTradingKey('main')).toBe(first);
    expect(sdk.createSecureClient).not.toHaveBeenCalled();
  });

  it('reads a missing backup without creating the account directory', () => {
    expect(account.readBackup('ghost')).toBeNull();
    expect(
      fs.existsSync(path.join(String(process.env.POLYGON_AGENT_HOME), 'polymarket', 'ghost'))
    ).toBe(false);
  });

  it('round-trips backup.json', () => {
    const b = { omsWalletId: 'w1', address: '0xAbC', at: '2026-10-09T00:00:00.000Z' };
    account.writeBackup('main', b);
    expect(account.readBackup('main')).toEqual(b);
  });
});

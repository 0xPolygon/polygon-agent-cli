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
    approveErc1155ForAll: vi.fn(async () => ({ wait: async () => ({ transactionHash: '0xb' }) })),
    transferErc20: vi.fn(async () => {
      if (sdk.transferFail) throw sdk.transferFail;
      return { wait: async () => ({ transactionHash: '0xSWEEP' }) };
    }),
    listPositions: vi.fn(() => ({
      firstPage: async () => ({ items: sdk.positions, hasMore: false })
    }))
  });
  const chain = { allowance: 0n, approved: false, fail: null as Error | null };
  const reads: Array<Record<string, unknown>> = [];
  return {
    owner: null as unknown,
    transferFail: null as Error | null,
    positions: [] as Array<Record<string, unknown>>,
    withdrawAddress: vi.fn(async () => '0xB2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2'),
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

vi.mock('./bridge.ts', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  withdrawAddress: sdk.withdrawAddress
}));

vi.mock('../oms-client.ts', () => ({ getOmsClient: () => ({ wallet: sdk.owner }) }));

const account = await import('./account.ts');
const { saveOmsWalletPointer } = await import('../storage.ts');
const { privateKeyToAccount } = await import('viem/accounts');

beforeEach(() => {
  sdk.created.length = 0;
  sdk.clients.length = 0;
  sdk.chain.allowance = 0n;
  sdk.chain.approved = false;
  sdk.chain.fail = null;
  sdk.reads.length = 0;
  sdk.clientApprovals.isFullyApproved = false;
  sdk.owner = null;
  sdk.transferFail = null;
  sdk.positions = [];
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

const MAIN = '0xC2F4cAfe89AE7e1bcB86dd3f141C0a3adCEB6C17';
const DEPOSIT_WALLET = '0xD0000000000000000000000000000000000000D0';
const PUSD_TOKEN = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';

// A stateful OMS owner session holding the main wallet and, optionally, the trading key.
function fakeOwner(tradingKey?: string) {
  const wallets: Array<Record<string, unknown>> = [
    { id: 'w-main', address: MAIN, keyOrigin: 'enclave' }
  ];
  if (tradingKey) {
    wallets.push({
      id: 'w-old',
      address: tradingKey,
      keyOrigin: 'imported',
      reference: 'polymarket-trading-key'
    });
  }
  const w = {
    walletAddress: MAIN as string | undefined,
    listWallets: vi.fn(async () => wallets),
    useWallet: vi.fn(async ({ walletId }: { walletId: string }) => {
      w.walletAddress = wallets.find((x) => x.id === walletId)?.address as string;
    }),
    importWallet: vi.fn(async ({ privateKey }: { privateKey: `0x${string}` }) => {
      const wallet = {
        id: 'w-new',
        address: privateKeyToAccount(privateKey).address,
        keyOrigin: 'imported'
      };
      wallets.push(wallet);
      w.walletAddress = wallet.address;
      return { wallet };
    }),
    signTypedData: vi.fn(),
    signMessage: vi.fn()
  };
  return w;
}

// An existing account whose key file has been lost. Returns the lost key's address.
async function accountWithLostKey(wallet: string): Promise<string> {
  const res = await account.setupAccount(wallet);
  fs.rmSync(account.accountFile(wallet, 'key.json'));
  sdk.created.length = 0;
  sdk.clients.length = 0;
  vi.clearAllMocks();
  return res.account.signer;
}

const pointer = (access?: 'session') =>
  saveOmsWalletPointer('main', {
    walletAddress: MAIN,
    loginMethod: 'google',
    createdAt: 'x',
    ...(access ? { access } : {})
  });

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { recursive: true }) as string[]) {
    const file = path.join(dir, entry);
    if (fs.statSync(file).isFile()) out[entry] = fs.readFileSync(file, 'utf8');
  }
  return out;
}

describe('getTradingClient with the key missing locally', () => {
  it('signs through OMS as the backed-up key with a live owner session', async () => {
    const signer = await accountWithLostKey('main');
    account.writeBackup('main', { omsWalletId: 'w-old', address: signer, at: 'x' });
    await pointer();
    const owner = fakeOwner(signer);
    sdk.owner = owner;
    const client = await account.getTradingClient('main');
    expect(client.account.wallet).toBe(DEPOSIT_WALLET);
    const opts = sdk.created[0];
    expect(opts.signer).not.toHaveProperty('__pk');
    expect(await (opts.signer as { getAddress(): Promise<string> }).getAddress()).toBe(signer);
    expect(opts.apiKey).toEqual({
      __builder: { key: 'b-key', secret: 'b-secret', passphrase: 'b-pass' }
    });
    expect(account.hasLocalKey('main')).toBe(false);
    expect(owner.importWallet).not.toHaveBeenCalled();
    expect(owner.walletAddress).toBe(MAIN);
  });

  it('fails with not_set_up and a sign-in hint without an owner session, making no key', async () => {
    const signer = await accountWithLostKey('main');
    account.writeBackup('main', { omsWalletId: 'w-old', address: signer, at: 'x' });
    await pointer('session');
    sdk.owner = fakeOwner(signer);
    await expect(account.getTradingClient('main')).rejects.toMatchObject({
      code: 'not_set_up',
      message: 'The Polymarket key is not on this machine; it is backed up in your OMS account.',
      hint: 'Sign in with agent wallet login to use it.'
    });
    expect(account.hasLocalKey('main')).toBe(false);
    expect(sdk.createSecureClient).not.toHaveBeenCalled();
  });

  it('fails the same way in owner mode when signed out', async () => {
    const signer = await accountWithLostKey('main');
    account.writeBackup('main', { omsWalletId: 'w-old', address: signer, at: 'x' });
    await pointer();
    const owner = fakeOwner(signer);
    owner.walletAddress = undefined;
    sdk.owner = owner;
    await expect(account.getTradingClient('main')).rejects.toMatchObject({
      code: 'not_set_up',
      hint: 'Sign in with agent wallet login to use it.'
    });
    expect(account.hasLocalKey('main')).toBe(false);
    expect(sdk.createSecureClient).not.toHaveBeenCalled();
  });

  it('reports the key missing when the owner session holds no copy of it', async () => {
    await accountWithLostKey('main');
    await pointer();
    sdk.owner = fakeOwner();
    await expect(account.getTradingClient('main')).rejects.toMatchObject({
      code: 'not_set_up',
      message: "The Polymarket key for wallet 'main' is missing."
    });
    expect(account.hasLocalKey('main')).toBe(false);
  });
});

describe('recoverAccount', () => {
  const previousDirs = (wallet: string) =>
    fs.readdirSync(account.accountDir(wallet)).filter((x) => x.startsWith('previous-'));

  it('sweeps pUSD to the main wallet, archives the old records, creates and backs up a new key', async () => {
    const signer = await accountWithLostKey('rec');
    const before = snapshot(account.accountDir('rec'));
    sdk.positions = [
      {
        title: 'Will it rain?',
        outcome: 'Yes',
        conditionId: '0xc1',
        currentSize: '10',
        currentValue: '4.2'
      }
    ];
    const owner = fakeOwner(signer);
    const out = await account.recoverAccount({
      wallet: 'rec',
      owner: owner as never,
      mainAddress: MAIN,
      target: { id: 'w-old', address: signer }
    });

    expect(out).toMatchObject({
      backedUp: true,
      omsWalletId: 'w-new',
      created: true,
      recovered: {
        withdrawnUsd: '2.5',
        txHash: '0xSWEEP',
        previousAccount: DEPOSIT_WALLET,
        positionsLeft: [
          {
            title: 'Will it rain?',
            outcome: 'Yes',
            conditionId: '0xc1',
            shares: '10',
            valueUsd: '4.2'
          }
        ]
      }
    });
    // The old account signs through OMS, with its stored builder key: nothing is minted.
    expect(await (sdk.created[0].signer as { getAddress(): Promise<string> }).getAddress()).toBe(
      signer
    );
    expect(sdk.createBuilderApiKey).not.toHaveBeenCalled();
    expect(sdk.withdrawAddress).toHaveBeenCalledWith({ wallet: DEPOSIT_WALLET, recipient: MAIN });
    expect(sdk.clients[0].transferErc20).toHaveBeenCalledWith({
      amount: 2_500_000n,
      recipientAddress: '0xB2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2',
      tokenAddress: PUSD_TOKEN
    });
    expect(sdk.clients[0].listPositions).toHaveBeenCalledWith({ status: 'OPEN' });

    // The old records moved, unchanged, into previous-<timestamp>/, plus a record of
    // which OMS wallet holds the old key (there was no local backup.json).
    const [prev] = previousDirs('rec');
    expect(out.recovered?.previousRecords).toBe(prev);
    const { 'backup.json': oldBackup, ...archived } = snapshot(
      path.join(account.accountDir('rec'), prev)
    );
    expect(archived).toEqual(before);
    expect(JSON.parse(oldBackup)).toMatchObject({ omsWalletId: 'w-old', address: signer });

    // A new key, backed up to OMS, and no account.json yet (setup creates the new account).
    const newKey = await account.ensureTradingKey('rec');
    expect(privateKeyToAccount(newKey).address).not.toBe(signer);
    expect(owner.importWallet).toHaveBeenCalledTimes(1);
    expect(account.readBackup('rec')).toMatchObject({
      omsWalletId: 'w-new',
      address: privateKeyToAccount(newKey).address
    });
    expect(account.loadAccount('rec')).toBeNull();
    expect(owner.walletAddress).toBe(MAIN);
  });

  it('a withdraw failure changes nothing on disk and creates no key', async () => {
    const signer = await accountWithLostKey('rec');
    const dir = account.accountDir('rec');
    const before = snapshot(dir);
    sdk.transferFail = new Error('relayer down');
    const owner = fakeOwner(signer);
    const out = await account.recoverAccount({
      wallet: 'rec',
      owner: owner as never,
      mainAddress: MAIN,
      target: { id: 'w-old', address: signer }
    });
    expect(out).toEqual({ backedUp: false, omsWalletId: 'w-old', error: 'relayer down' });
    expect(snapshot(dir)).toEqual(before);
    expect(account.hasLocalKey('rec')).toBe(false);
    expect(owner.importWallet).not.toHaveBeenCalled();
  });

  it('stops before anything moves when the key controls a different wallet than recorded', async () => {
    const signer = await accountWithLostKey('rec');
    const file = account.accountFile('rec', 'account.json');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(
      file,
      JSON.stringify({ ...rec, wallet: '0xE0000000000000000000000000000000000000E0' })
    );
    const before = snapshot(account.accountDir('rec'));
    const out = await account.recoverAccount({
      wallet: 'rec',
      owner: fakeOwner(signer) as never,
      mainAddress: MAIN,
      target: { id: 'w-old', address: signer }
    });
    expect(out.backedUp).toBe(false);
    expect(out.error).toMatch(/not the recorded Polymarket wallet/);
    expect(sdk.clients[0].transferErc20).not.toHaveBeenCalled();
    expect(snapshot(account.accountDir('rec'))).toEqual(before);
  });

  it('skips the withdraw for an empty account and still replaces the key', async () => {
    const signer = await accountWithLostKey('rec');
    sdk.updateBalanceAllowance.mockResolvedValue({ balance: '0', allowances: {} });
    const out = await account.recoverAccount({
      wallet: 'rec',
      owner: fakeOwner(signer) as never,
      mainAddress: MAIN,
      target: { id: 'w-old', address: signer }
    });
    sdk.updateBalanceAllowance.mockResolvedValue({ balance: '2500000', allowances: {} });
    expect(out).toMatchObject({
      backedUp: true,
      created: true,
      recovered: { withdrawnUsd: '0', txHash: null, positionsLeft: [] }
    });
    expect(sdk.clients[0].transferErc20).not.toHaveBeenCalled();
    expect(previousDirs('rec')).toHaveLength(1);
  });

  it('rebuilds a wiped account from OMS alone: mints a builder key as the EOA, then sweeps', async () => {
    const lost = privateKeyToAccount(`0x${'cd'.repeat(32)}`).address;
    const owner = fakeOwner(lost);
    const out = await account.recoverAccount({
      wallet: 'wiped',
      owner: owner as never,
      mainAddress: MAIN,
      target: { id: 'w-old', address: lost }
    });
    expect(out).toMatchObject({
      backedUp: true,
      created: true,
      recovered: { withdrawnUsd: '2.5', txHash: '0xSWEEP', previousAccount: DEPOSIT_WALLET }
    });
    // EOA-mode client mints the builder key, then the deposit-wallet client uses it.
    expect(sdk.created[0].wallet).toBe(lost);
    expect(sdk.createBuilderApiKey).toHaveBeenCalledTimes(1);
    expect(sdk.created[1].wallet).toBeUndefined();
    expect(sdk.created[1].apiKey).toEqual({
      __builder: { key: 'b-key', secret: 'b-secret', passphrase: 'b-pass' }
    });
    expect(sdk.clients[1].transferErc20).toHaveBeenCalledTimes(1);
    // The old account's identity is kept in the archive.
    const [prev] = previousDirs('wiped');
    const archived = snapshot(path.join(account.accountDir('wiped'), prev));
    expect(JSON.parse(archived['account.json'])).toMatchObject({
      kind: 'deposit-wallet',
      signer: lost,
      wallet: DEPOSIT_WALLET
    });
    expect(JSON.parse(archived['backup.json'])).toMatchObject({
      omsWalletId: 'w-old',
      address: lost
    });
    expect(account.readBackup('wiped')?.omsWalletId).toBe('w-new');
  });

  it('a failed builder-key mint on a wiped machine writes nothing', async () => {
    const lost = privateKeyToAccount(`0x${'ef'.repeat(32)}`).address;
    sdk.createBuilderApiKey.mockRejectedValueOnce(new Error('relayer down'));
    const owner = fakeOwner(lost);
    const out = await account.recoverAccount({
      wallet: 'wiped2',
      owner: owner as never,
      mainAddress: MAIN,
      target: { id: 'w-old', address: lost }
    });
    expect(out).toEqual({ backedUp: false, omsWalletId: 'w-old', error: 'relayer down' });
    expect(
      fs.existsSync(path.join(String(process.env.POLYGON_AGENT_HOME), 'polymarket', 'wiped2'))
    ).toBe(false);
    expect(owner.importWallet).not.toHaveBeenCalled();
  });
});

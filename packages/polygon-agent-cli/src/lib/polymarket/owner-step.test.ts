import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-owner-step-'));

const recoverAccount = vi.hoisted(() => vi.fn());
vi.mock('./account.ts', async (o) => ({
  ...(await o<Record<string, unknown>>()),
  recoverAccount
}));

const { privateKeyToAccount } = await import('viem/accounts');
const { accountDir, accountFile, readBackup, hasLocalKey } = await import('./account.ts');
const { polymarketOwnerStep } = await import('./owner-step.ts');

const MAIN = '0xC2F4cAfe89AE7e1bcB86dd3f141C0a3adCEB6C17';

// A stateful OMS fake: import adds an imported wallet and, like the real SDK, switches to it.
function fakeOwner() {
  const wallets: Array<Record<string, unknown>> = [
    { id: 'w-main', address: MAIN, keyOrigin: 'generated' }
  ];
  const w = {
    walletAddress: MAIN as string | undefined,
    listWallets: vi.fn(async () => wallets),
    useWallet: vi.fn(async ({ walletId }: { walletId: string }) => {
      w.walletAddress = wallets.find((x) => x.id === walletId)?.address as string;
    }),
    importWallet: vi.fn(async ({ privateKey }: { privateKey: `0x${string}` }) => {
      const address = privateKeyToAccount(privateKey).address;
      const wallet = { id: 'w-imported', address, keyOrigin: 'imported' };
      wallets.push(wallet);
      w.walletAddress = address;
      return { wallet };
    }),
    signTypedData: vi.fn(),
    signMessage: vi.fn()
  };
  return w;
}

let n = 0;
let wallet: string;
beforeEach(() => {
  wallet = `w${n++}`;
  recoverAccount.mockReset();
  recoverAccount.mockResolvedValue({ backedUp: true, omsWalletId: 'w-new', recovered: {} });
});

describe('polymarketOwnerStep', () => {
  it('creates and backs up a key for a wallet with none, then selects the main wallet', async () => {
    const owner = fakeOwner();
    const out = await polymarketOwnerStep({ wallet, owner: owner as never, mainAddress: MAIN });
    expect(out).toEqual({ backedUp: true, omsWalletId: 'w-imported', created: true });
    expect(owner.importWallet).toHaveBeenCalledTimes(1);
    expect(owner.walletAddress).toBe(MAIN);
    expect(readBackup(wallet)?.omsWalletId).toBe('w-imported');
    expect(fs.readFileSync(accountFile(wallet, 'backup.json'), 'utf8')).not.toMatch(
      /0x[0-9a-f]{64}/
    );
  });

  it('a later call makes no second import', async () => {
    const owner = fakeOwner();
    await polymarketOwnerStep({ wallet, owner: owner as never, mainAddress: MAIN });
    const out = await polymarketOwnerStep({ wallet, owner: owner as never, mainAddress: MAIN });
    expect(out).toEqual({ backedUp: true, omsWalletId: 'w-imported' });
    expect(owner.importWallet).toHaveBeenCalledTimes(1);
  });

  it('backs up an existing local key that has no backup, without reporting created', async () => {
    const owner = fakeOwner();
    // First run creates the key; drop only the backup record.
    await polymarketOwnerStep({ wallet, owner: owner as never, mainAddress: MAIN });
    fs.rmSync(accountFile(wallet, 'backup.json'));
    const out = await polymarketOwnerStep({ wallet, owner: owner as never, mainAddress: MAIN });
    expect(out).toEqual({ backedUp: true, omsWalletId: 'w-imported' });
    expect(owner.importWallet).toHaveBeenCalledTimes(1);
  });

  it('reports backedUp false instead of throwing when the import fails, and still selects main', async () => {
    const owner = fakeOwner();
    owner.importWallet.mockImplementation(async () => {
      owner.walletAddress = '0xdead';
      throw new Error('oms down');
    });
    owner.useWallet.mockImplementation(async () => {
      owner.walletAddress = MAIN;
    });
    const out = await polymarketOwnerStep({ wallet, owner: owner as never, mainAddress: MAIN });
    expect(out).toEqual({ backedUp: false, error: 'oms down' });
    expect(owner.walletAddress).toBe(MAIN);
  });

  it('changes nothing when the account exists, its key is missing and OMS has no copy', async () => {
    fs.writeFileSync(
      path.join(accountDir(wallet), 'account.json'),
      JSON.stringify({ wallet: '0x1', signer: '0x0000000000000000000000000000000000000002' })
    );
    const owner = fakeOwner();
    const out = await polymarketOwnerStep({ wallet, owner: owner as never, mainAddress: MAIN });
    expect(out.backedUp).toBe(false);
    expect(out.error).toMatch(/missing/);
    expect(hasLocalKey(wallet)).toBe(false);
    expect(owner.importWallet).not.toHaveBeenCalled();
    expect(recoverAccount).not.toHaveBeenCalled();
  });

  it('recovers the recorded key when the account exists, its key is missing and OMS holds it', async () => {
    const signer = '0x00000000000000000000000000000000000000A1';
    fs.writeFileSync(
      path.join(accountDir(wallet), 'account.json'),
      JSON.stringify({ wallet: '0x1', signer })
    );
    const owner = fakeOwner();
    (await owner.listWallets()).push(
      {
        id: 'w-other',
        address: '0xOTHER',
        keyOrigin: 'imported',
        reference: 'polymarket-trading-key'
      },
      { id: 'w-old', address: signer, keyOrigin: 'imported', reference: 'polymarket-trading-key' }
    );
    owner.walletAddress = '0xdead';
    const out = await polymarketOwnerStep({ wallet, owner: owner as never, mainAddress: MAIN });
    expect(recoverAccount).toHaveBeenCalledWith({
      wallet,
      owner,
      mainAddress: MAIN,
      target: { id: 'w-old', address: signer }
    });
    expect(out).toEqual({ backedUp: true, omsWalletId: 'w-new', recovered: {} });
    expect(owner.importWallet).not.toHaveBeenCalled();
    expect(owner.walletAddress).toBe(MAIN);
  });

  it('selects the main wallet afterwards even when it was left elsewhere', async () => {
    const owner = fakeOwner();
    owner.walletAddress = '0xdead';
    await polymarketOwnerStep({ wallet, owner: owner as never, mainAddress: MAIN });
    expect(owner.walletAddress).toBe(MAIN);
  });

  it('puts a failed final main-wallet select in mainWalletError after a good backup', async () => {
    const owner = fakeOwner();
    owner.importWallet.mockImplementationOnce(async ({ privateKey }) => {
      const address = privateKeyToAccount(privateKey).address;
      const w = { id: 'w-imported', address, keyOrigin: 'imported' };
      (await owner.listWallets()).push(w);
      owner.walletAddress = MAIN;
      owner.listWallets.mockRejectedValue(new Error('boom'));
      return { wallet: w };
    });
    const out = await polymarketOwnerStep({ wallet, owner: owner as never, mainAddress: MAIN });
    expect(out).toEqual({
      backedUp: true,
      omsWalletId: 'w-imported',
      created: true,
      mainWalletError: 'boom'
    });
  });

  it('never throws when listing wallets fails from the start', async () => {
    const owner = fakeOwner();
    owner.listWallets.mockRejectedValue(new Error('boom'));
    const out = await polymarketOwnerStep({ wallet, owner: owner as never, mainAddress: MAIN });
    expect(out).toEqual({ backedUp: false, error: 'boom' });
  });

  it('routes to recovery, never creating a key, when OMS already holds a trading key and nothing is local', async () => {
    const owner = fakeOwner();
    (await owner.listWallets()).push({
      id: 'w-old',
      address: '0xOLD',
      keyOrigin: 'imported',
      reference: 'polymarket-trading-key'
    });
    recoverAccount.mockResolvedValue({
      backedUp: false,
      omsWalletId: 'w-old',
      error: 'relayer down'
    });
    const out = await polymarketOwnerStep({ wallet, owner: owner as never, mainAddress: MAIN });
    expect(recoverAccount).toHaveBeenCalledWith({
      wallet,
      owner,
      mainAddress: MAIN,
      target: { id: 'w-old', address: '0xOLD' }
    });
    expect(out).toEqual({ backedUp: false, omsWalletId: 'w-old', error: 'relayer down' });
    expect(owner.importWallet).not.toHaveBeenCalled();
    expect(hasLocalKey(wallet)).toBe(false);
  });

  it('reports a recovery that throws as backedUp false and still selects main', async () => {
    const owner = fakeOwner();
    (await owner.listWallets()).push({
      id: 'w-old',
      address: '0xOLD',
      keyOrigin: 'imported',
      reference: 'polymarket-trading-key'
    });
    recoverAccount.mockRejectedValue(new Error('boom'));
    owner.walletAddress = '0xOLD';
    const out = await polymarketOwnerStep({ wallet, owner: owner as never, mainAddress: MAIN });
    expect(out).toEqual({ backedUp: false, error: 'boom' });
    expect(owner.walletAddress).toBe(MAIN);
  });

  it('re-backs up when backup.json records a different address than the local key', async () => {
    const owner = fakeOwner();
    await polymarketOwnerStep({ wallet, owner: owner as never, mainAddress: MAIN });
    const file = accountFile(wallet, 'backup.json');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...rec,
        address: '0x0000000000000000000000000000000000000001',
        omsWalletId: 'stale'
      })
    );
    const out = await polymarketOwnerStep({ wallet, owner: owner as never, mainAddress: MAIN });
    expect(out).toEqual({ backedUp: true, omsWalletId: 'w-imported' });
    expect(readBackup(wallet)?.omsWalletId).toBe('w-imported');
    expect(owner.importWallet).toHaveBeenCalledTimes(1);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-owner-step-'));

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

  it('does not recover or overwrite when the account exists but the key is missing', async () => {
    fs.writeFileSync(
      path.join(accountDir(wallet), 'account.json'),
      JSON.stringify({ wallet: '0x1' })
    );
    const owner = fakeOwner();
    const out = await polymarketOwnerStep({ wallet, owner: owner as never, mainAddress: MAIN });
    expect(out.backedUp).toBe(false);
    expect(out.error).toMatch(/missing/);
    expect(hasLocalKey(wallet)).toBe(false);
    expect(owner.importWallet).not.toHaveBeenCalled();
  });

  it('selects the main wallet afterwards even when it was left elsewhere', async () => {
    const owner = fakeOwner();
    owner.walletAddress = '0xdead';
    await polymarketOwnerStep({ wallet, owner: owner as never, mainAddress: MAIN });
    expect(owner.walletAddress).toBe(MAIN);
  });

  it('never throws when selecting the main wallet fails', async () => {
    const owner = fakeOwner();
    owner.listWallets.mockRejectedValue(new Error('boom'));
    const out = await polymarketOwnerStep({ wallet, owner: owner as never, mainAddress: MAIN });
    expect(out).toEqual({ backedUp: false, error: 'boom' });
  });
});

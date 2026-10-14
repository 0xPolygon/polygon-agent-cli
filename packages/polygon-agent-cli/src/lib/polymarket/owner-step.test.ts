import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-owner-step-'));

const { recoverOtherKey, restoreFromOms, sweepOldKey } = vi.hoisted(() => ({
  recoverOtherKey: vi.fn(),
  restoreFromOms: vi.fn(),
  sweepOldKey: vi.fn()
}));
vi.mock('./account.ts', async (o) => ({
  ...(await o<Record<string, unknown>>()),
  recoverOtherKey,
  restoreFromOms,
  sweepOldKey
}));

const { privateKeyToAccount } = await import('viem/accounts');
const { accountDir, accountFile, readBackup, hasLocalKey, writeBackup } =
  await import('./account.ts');
const { readExistingAccount } = await import('./find-key.ts');
const { polymarketOwnerStep } = await import('./owner-step.ts');
const { installTradingKeyReference, SHARED_TRADING_KEY_REFERENCE, tradingKeyReference } =
  await import('./oms-key.ts');

// This install's own older label, the shared one, and another install's.
const OURS = installTradingKeyReference();
const SHARED = SHARED_TRADING_KEY_REFERENCE;
const THEIRS = tradingKeyReference('some-other-install');

const MAIN = '0xC2F4cAfe89AE7e1bcB86dd3f141C0a3adCEB6C17';
const OLD = '0x00000000000000000000000000000000000000A1';

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
    importWallet: vi.fn(
      async ({ privateKey, reference }: { privateKey: `0x${string}`; reference?: string }) => {
        const address = privateKeyToAccount(privateKey).address;
        const wallet = { id: 'w-imported', address, keyOrigin: 'imported', reference };
        wallets.push(wallet);
        w.walletAddress = address;
        return { wallet };
      }
    ),
    signTypedData: vi.fn(),
    signMessage: vi.fn()
  };
  return w;
}

const addKey = async (
  owner: ReturnType<typeof fakeOwner>,
  key: { id: string; address: string; reference: string }
) => (await owner.listWallets()).push({ ...key, keyOrigin: 'imported' });

// What the old account holds, as the read-only probe reports it.
const holds = (pusd: string, positions: unknown[] = []) => ({
  address: OLD,
  account: '0xACCOUNT',
  pusd,
  positionsLeft: positions
});

let n = 0;
let wallet: string;
// A session-mode sign-in by default: it ends after the request.
const step = (owner: ReturnType<typeof fakeOwner>, signsWithOms = false) =>
  polymarketOwnerStep({ wallet, owner: owner as never, mainAddress: MAIN, signsWithOms });

beforeEach(() => {
  wallet = `w${n++}`;
  recoverOtherKey.mockReset();
  recoverOtherKey.mockResolvedValue(holds('0'));
  restoreFromOms.mockReset();
  restoreFromOms.mockResolvedValue({
    account: { kind: 'deposit-wallet', signer: OLD, wallet: '0xACCOUNT', createdAt: 'x' },
    approvalsSet: false,
    backup: { omsWalletId: 'w-old', address: OLD, at: 'x', kind: 'deposit-wallet' }
  });
  sweepOldKey.mockReset();
  sweepOldKey.mockResolvedValue(null);
});

describe('polymarketOwnerStep', () => {
  it('creates a key backed up under the shared label, then selects the main wallet', async () => {
    const owner = fakeOwner();
    const out = await step(owner);
    expect(out).toEqual({ backedUp: true, omsWalletId: 'w-imported', created: true });
    expect(owner.importWallet).toHaveBeenCalledTimes(1);
    expect(owner.importWallet).toHaveBeenCalledWith(expect.objectContaining({ reference: SHARED }));
    expect(owner.walletAddress).toBe(MAIN);
    expect(readBackup(wallet)?.omsWalletId).toBe('w-imported');
    expect(fs.readFileSync(accountFile(wallet, 'backup.json'), 'utf8')).not.toMatch(
      /0x[0-9a-f]{64}/
    );
  });

  it('a later call makes no second import', async () => {
    const owner = fakeOwner();
    await step(owner);
    const out = await step(owner);
    expect(out).toEqual({ backedUp: true, omsWalletId: 'w-imported' });
    expect(owner.importWallet).toHaveBeenCalledTimes(1);
  });

  it('backs up an existing local key that has no backup, without reporting created', async () => {
    const owner = fakeOwner();
    // First run creates the key; drop only the backup record.
    await step(owner);
    fs.rmSync(accountFile(wallet, 'backup.json'));
    const out = await step(owner);
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
    const out = await step(owner);
    expect(out).toEqual({ backedUp: false, error: 'oms down' });
    expect(owner.walletAddress).toBe(MAIN);
  });

  it('changes nothing when the account exists, its key is missing and OMS has no copy', async () => {
    fs.writeFileSync(
      path.join(accountDir(wallet), 'account.json'),
      JSON.stringify({ wallet: '0x1', signer: '0x0000000000000000000000000000000000000002' })
    );
    const owner = fakeOwner();
    const out = await step(owner);
    expect(out.backedUp).toBe(false);
    expect(out.error).toMatch(/missing/);
    expect(hasLocalKey(wallet)).toBe(false);
    expect(owner.importWallet).not.toHaveBeenCalled();
  });

  it('selects the main wallet afterwards even when it was left elsewhere', async () => {
    const owner = fakeOwner();
    owner.walletAddress = '0xdead';
    await step(owner);
    expect(owner.walletAddress).toBe(MAIN);
  });

  it('puts a failed final main-wallet select in mainWalletError after a good backup', async () => {
    const owner = fakeOwner();
    owner.importWallet.mockImplementationOnce(async ({ privateKey, reference }) => {
      const address = privateKeyToAccount(privateKey).address;
      const w = { id: 'w-imported', address, keyOrigin: 'imported', reference };
      (await owner.listWallets()).push(w);
      owner.walletAddress = MAIN;
      owner.listWallets.mockRejectedValue(new Error('boom'));
      return { wallet: w };
    });
    const out = await step(owner);
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
    const out = await step(owner);
    expect(out).toEqual({ backedUp: false, error: 'boom' });
  });

  it('re-backs up when backup.json records a different address than the local key', async () => {
    const owner = fakeOwner();
    await step(owner);
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
    const out = await step(owner);
    expect(out).toEqual({ backedUp: true, omsWalletId: 'w-imported' });
    expect(readBackup(wallet)?.omsWalletId).toBe('w-imported');
    expect(owner.importWallet).toHaveBeenCalledTimes(1);
  });

  describe('no local key, and OMS holds the account', () => {
    it('kept signed in: restores the account and signs through OMS, making no key', async () => {
      const owner = fakeOwner();
      await addKey(owner, { id: 'w-old', address: OLD, reference: SHARED });
      const out = await step(owner, true);
      expect(restoreFromOms).toHaveBeenCalledWith({
        wallet,
        owner,
        target: { id: 'w-old', address: OLD }
      });
      expect(out).toEqual({
        backedUp: true,
        omsWalletId: 'w-old',
        restored: true,
        account: '0xACCOUNT'
      });
      expect(owner.importWallet).not.toHaveBeenCalled();
      expect(recoverOtherKey).not.toHaveBeenCalled();
    });

    it('a sign-in that ends: says the account exists and one more sign-in uses it here', async () => {
      const owner = fakeOwner();
      await addKey(owner, { id: 'w-old', address: OLD, reference: SHARED });
      recoverOtherKey.mockResolvedValue(holds('4.2', [{ title: 'Q1' }, { title: 'Q2' }]));
      const out = await step(owner);
      expect(recoverOtherKey).toHaveBeenCalledWith(
        expect.objectContaining({ target: { id: 'w-old', address: OLD }, broadcast: false })
      );
      expect(out).toEqual({
        backedUp: false,
        existingAccount: {
          address: OLD,
          account: '0xACCOUNT',
          pusd: '4.2',
          positions: 2,
          message:
            'You already have a Polymarket account with $4.20 and 2 open positions. Sign in once more to use it here.',
          command: `polygon-agent wallet login --owner --name ${wallet}`
        }
      });
      expect(readExistingAccount(wallet)).toMatchObject({ address: OLD, pusd: '4.2' });
      expect(owner.importWallet).not.toHaveBeenCalled();
      expect(restoreFromOms).not.toHaveBeenCalled();
      expect(hasLocalKey(wallet)).toBe(false);
      expect(owner.walletAddress).toBe(MAIN);
    });

    it('a sign-in that ends, over an empty account: gives this install a key under the shared label', async () => {
      const owner = fakeOwner();
      await addKey(owner, { id: 'w-old', address: OLD, reference: SHARED });
      const out = await step(owner);
      expect(out).toEqual({ backedUp: true, omsWalletId: 'w-imported', created: true });
      expect(owner.importWallet).toHaveBeenCalledWith(
        expect.objectContaining({ reference: SHARED })
      );
      expect(readExistingAccount(wallet)).toBeNull();
    });

    it('finds the recorded key by address, whatever its label', async () => {
      fs.writeFileSync(
        path.join(accountDir(wallet), 'account.json'),
        JSON.stringify({ wallet: '0xACCOUNT', signer: OLD })
      );
      const owner = fakeOwner();
      await addKey(owner, { id: 'w-other', address: '0xOTHER', reference: SHARED });
      await addKey(owner, { id: 'w-old', address: OLD, reference: 'polymarket-trading-key' });
      const out = await step(owner, true);
      expect(restoreFromOms).toHaveBeenCalledWith(
        expect.objectContaining({ target: { id: 'w-old', address: OLD } })
      );
      expect(out).toMatchObject({ restored: true });
    });

    it("a recorded account over an empty probe still isn't replaced", async () => {
      fs.writeFileSync(
        path.join(accountDir(wallet), 'account.json'),
        JSON.stringify({ wallet: '0xACCOUNT', signer: OLD })
      );
      const owner = fakeOwner();
      await addKey(owner, { id: 'w-old', address: OLD, reference: SHARED });
      const out = await step(owner);
      expect(out).toMatchObject({ backedUp: false, existingAccount: { address: OLD } });
      expect(owner.importWallet).not.toHaveBeenCalled();
    });

    it("finds this install's own older label when there is no shared key", async () => {
      const owner = fakeOwner();
      await addKey(owner, { id: 'w-old', address: OLD, reference: OURS });
      await step(owner, true);
      expect(restoreFromOms).toHaveBeenCalledWith(
        expect.objectContaining({ target: { id: 'w-old', address: OLD } })
      );
    });

    it('a failing probe is reported and nothing is made or changed', async () => {
      const owner = fakeOwner();
      await addKey(owner, { id: 'w-old', address: OLD, reference: SHARED });
      recoverOtherKey.mockRejectedValue(new Error('data api down'));
      const out = await step(owner);
      expect(out).toEqual({ backedUp: false, error: 'data api down' });
      expect(owner.importWallet).not.toHaveBeenCalled();
      expect(owner.walletAddress).toBe(MAIN);
    });
  });

  describe("another install's older key", () => {
    const A = '0x00000000000000000000000000000000000000A0';

    it('is the account when it is the one key that holds something', async () => {
      const owner = fakeOwner();
      await addKey(owner, { id: 'w-a', address: A, reference: THEIRS });
      recoverOtherKey.mockResolvedValue(holds('3'));
      const out = await step(owner);
      expect(out).toMatchObject({ backedUp: false, existingAccount: { address: A, pusd: '3' } });
      expect(owner.importWallet).not.toHaveBeenCalled();
    });

    it('is left alone when it holds nothing: this install makes the shared key', async () => {
      const owner = fakeOwner();
      await addKey(owner, { id: 'w-a', address: A, reference: THEIRS });
      const out = await step(owner);
      expect(out).toEqual({ backedUp: true, omsWalletId: 'w-imported', created: true });
      expect(owner.useWallet).not.toHaveBeenCalledWith({ walletId: 'w-a' });
    });

    it('a bare-prefix key is treated the same way', async () => {
      const owner = fakeOwner();
      await addKey(owner, { id: 'w-bare', address: A, reference: 'polymarket-trading-key' });
      recoverOtherKey.mockResolvedValue(holds('1'));
      const out = await step(owner);
      expect(out).toMatchObject({ backedUp: false, existingAccount: { address: A } });
    });

    it('is not probed when this machine already uses it under another wallet name', async () => {
      const owner = fakeOwner();
      await addKey(owner, { id: 'w-a', address: A, reference: THEIRS });
      writeBackup(`w${n++}`, { omsWalletId: 'w-a', address: A, at: 'x' });
      const out = await step(owner);
      expect(recoverOtherKey).not.toHaveBeenCalled();
      expect(out).toMatchObject({ backedUp: true, created: true });
    });
  });

  describe('sweeping keys this install replaced', () => {
    const OLDER = '0x00000000000000000000000000000000000000B1';
    const OLDER2 = '0x00000000000000000000000000000000000000B2';
    const addOlder = async (owner: ReturnType<typeof fakeOwner>, id: string, address: string) =>
      (await owner.listWallets()).push({ id, address, keyOrigin: 'imported', reference: OURS });
    // An earlier recovery archived this install's old account under previous-*.
    const archive = (folder: string, signer: string, backupAddress = signer) => {
      const dir = path.join(accountDir(wallet), `previous-${folder}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'account.json'),
        JSON.stringify({ kind: 'deposit-wallet', wallet: '0x2', signer })
      );
      fs.writeFileSync(
        path.join(dir, 'backup.json'),
        JSON.stringify({ omsWalletId: 'x', address: backupAddress, at: 'x' })
      );
    };
    const withCurrentKey = async () => {
      const owner = fakeOwner();
      await step(owner);
      sweepOldKey.mockClear();
      return owner;
    };

    it('sweeps an archived funded key to the main wallet and leaves the current key alone', async () => {
      const owner = await withCurrentKey();
      await addOlder(owner, 'w-older', OLDER);
      archive('1', OLDER);
      sweepOldKey.mockResolvedValueOnce({ withdrawnUsd: '3', txHash: '0xS' });
      const out = await step(owner);
      expect(out).toEqual({
        backedUp: true,
        omsWalletId: 'w-imported',
        sweptPrevious: [{ address: OLDER, withdrawnUsd: '3', txHash: '0xS' }]
      });
      expect(sweepOldKey).toHaveBeenCalledTimes(1);
      expect(sweepOldKey).toHaveBeenCalledWith({
        owner,
        target: { id: 'w-older', address: OLDER },
        mainAddress: MAIN
      });
      expect(owner.walletAddress).toBe(MAIN);
    });

    it("never sweeps keys it has no archive for: unknown keys or other installs'", async () => {
      const owner = await withCurrentKey();
      await addOlder(owner, 'w-older', OLDER);
      (await owner.listWallets()).push({
        id: 'w-a',
        address: OLDER2,
        keyOrigin: 'imported',
        reference: THEIRS
      });
      const out = await step(owner);
      expect(sweepOldKey).not.toHaveBeenCalled();
      expect(out).toEqual({ backedUp: true, omsWalletId: 'w-imported' });
    });

    it('skips an archived key with nothing to sweep without reporting it', async () => {
      const owner = await withCurrentKey();
      await addOlder(owner, 'w-older', OLDER);
      archive('1', OLDER);
      const out = await step(owner);
      expect(sweepOldKey).toHaveBeenCalledTimes(1);
      expect(out).toEqual({ backedUp: true, omsWalletId: 'w-imported' });
    });

    it('reports a failing sweep and still sweeps the others, without failing the step', async () => {
      const owner = await withCurrentKey();
      await addOlder(owner, 'w-older', OLDER);
      await addOlder(owner, 'w-older2', OLDER2);
      archive('1', OLDER);
      archive('2', OLDER2);
      sweepOldKey
        .mockRejectedValueOnce(new Error('relayer down'))
        .mockResolvedValueOnce({ withdrawnUsd: '1', txHash: '0xT' });
      const out = await step(owner);
      expect(out).toEqual({
        backedUp: true,
        omsWalletId: 'w-imported',
        sweptPrevious: [
          { address: OLDER, error: 'relayer down' },
          { address: OLDER2, withdrawnUsd: '1', txHash: '0xT' }
        ]
      });
      expect(owner.walletAddress).toBe(MAIN);
    });

    it('never sweeps a key another wallet name on this machine still uses', async () => {
      fs.writeFileSync(
        path.join(accountDir(`${wallet}-other`), 'account.json'),
        JSON.stringify({ kind: 'deposit-wallet', wallet: '0x2', signer: OLDER })
      );
      const owner = await withCurrentKey();
      await addOlder(owner, 'w-older', OLDER);
      archive('1', OLDER);
      await step(owner);
      expect(sweepOldKey).not.toHaveBeenCalled();
    });

    it('does not sweep the key it just found for the account', async () => {
      const signer = '0x00000000000000000000000000000000000000C1';
      fs.writeFileSync(
        path.join(accountDir(wallet), 'account.json'),
        JSON.stringify({ kind: 'deposit-wallet', wallet: '0x1', signer })
      );
      archive('1', signer);
      const owner = fakeOwner();
      await addOlder(owner, 'w-old', signer);
      await step(owner);
      expect(recoverOtherKey).toHaveBeenCalledTimes(1);
      expect(sweepOldKey).not.toHaveBeenCalled();
    });
  });
});

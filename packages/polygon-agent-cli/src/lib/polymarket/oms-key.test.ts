import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import type { OmsWalletLike } from './oms-key.ts';

import { CliError } from '../errors.ts';
import {
  backupTradingKey,
  omsSigner,
  selectMainWallet,
  TRADING_KEY_REFERENCE,
  withActiveWallet
} from './oms-key.ts';

interface FakeAccount {
  id: string;
  type: 'ethereum';
  address: string;
  reference?: string;
  keyOrigin: 'enclave' | 'imported';
}

function fakeOms(initial: FakeAccount[], activeId: string, opts: { importAddress?: string } = {}) {
  const wallets = [...initial];
  let active = activeId;
  const calls: string[] = [];
  const signed: Array<{ active: string; payload: unknown }> = [];
  const byId = (id: string) => wallets.find((x) => x.id === id)!;
  const w = {
    get walletAddress() {
      return byId(active).address;
    },
    async listWallets() {
      return wallets.map((x) => ({ ...x }));
    },
    async useWallet({ walletId }: { walletId: string }) {
      calls.push(`use:${walletId}`);
      active = walletId;
      return { walletAddress: byId(walletId).address, wallet: byId(walletId) };
    },
    async importWallet(p: { privateKey: string; reference?: string }) {
      calls.push('import');
      const address =
        opts.importAddress ?? privateKeyToAccount(p.privateKey as `0x${string}`).address;
      const acct: FakeAccount = {
        id: `imp-${wallets.length}`,
        type: 'ethereum',
        address,
        reference: p.reference,
        keyOrigin: 'imported'
      };
      wallets.push(acct);
      active = acct.id;
      return { walletAddress: address, wallet: acct };
    },
    async signTypedData(p: unknown) {
      signed.push({ active, payload: p });
      return '0xsig';
    },
    async signMessage(p: unknown) {
      signed.push({ active, payload: p });
      return '0xmsg';
    }
  };
  return { w: w as unknown as OmsWalletLike, calls, signed, getActive: () => active };
}

const MAIN: FakeAccount = {
  id: 'main',
  type: 'ethereum',
  address: '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa',
  keyOrigin: 'enclave'
};
const IMPORTED: FakeAccount = {
  id: 'imp-x',
  type: 'ethereum',
  address: '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb',
  reference: 'other',
  keyOrigin: 'imported'
};

describe('selectMainWallet', () => {
  it('picks the expected address case-insensitively and switches to it', async () => {
    const f = fakeOms([IMPORTED, MAIN], 'imp-x');
    const r = await selectMainWallet(f.w, { expectedAddress: MAIN.address.toLowerCase() });
    expect(r).toEqual({ id: 'main', address: MAIN.address });
    expect(f.getActive()).toBe('main');
  });

  it('picks the first non-imported wallet even when an imported one is listed first', async () => {
    const f = fakeOms([IMPORTED, MAIN], 'imp-x');
    const r = await selectMainWallet(f.w, {});
    expect(r.id).toBe('main');
    expect(f.getActive()).toBe('main');
  });

  it('does not call useWallet when already active', async () => {
    const f = fakeOms([MAIN, IMPORTED], 'main');
    await selectMainWallet(f.w, {});
    expect(f.calls).toEqual([]);
  });

  it('throws not_connected when only imported wallets exist', async () => {
    const f = fakeOms([IMPORTED], 'imp-x');
    await expect(selectMainWallet(f.w, {})).rejects.toMatchObject({ code: 'not_connected' });
    await expect(selectMainWallet(f.w, {})).rejects.toBeInstanceOf(CliError);
  });
});

describe('withActiveWallet', () => {
  it('restores the previous wallet when fn throws', async () => {
    const f = fakeOms([MAIN, IMPORTED], 'main');
    await expect(
      withActiveWallet(f.w, 'imp-x', async () => {
        expect(f.getActive()).toBe('imp-x');
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(f.getActive()).toBe('main');
  });

  it('just runs fn when the target is already active', async () => {
    const f = fakeOms([MAIN, IMPORTED], 'main');
    const out = await withActiveWallet(f.w, 'main', async () => 7);
    expect(out).toBe(7);
    expect(f.calls).toEqual([]);
  });
});

describe('backupTradingKey', () => {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;

  it('imports once, restores the active wallet, and is idempotent', async () => {
    const f = fakeOms([MAIN], 'main');
    const first = await backupTradingKey(f.w, key);
    expect(first).toMatchObject({ address, imported: true });
    expect(f.getActive()).toBe('main');
    expect(f.calls.filter((c) => c === 'import')).toHaveLength(1);

    const second = await backupTradingKey(f.w, key);
    expect(second).toEqual({ omsWalletId: first.omsWalletId, address, imported: false });
    expect(f.calls.filter((c) => c === 'import')).toHaveLength(1);
    expect(f.getActive()).toBe('main');
  });

  it('uses the trading key reference on import', async () => {
    expect(TRADING_KEY_REFERENCE).toBe('polymarket-trading-key');
  });

  it('throws upstream_error on an address mismatch and still restores the wallet', async () => {
    const f = fakeOms([MAIN], 'main', { importAddress: IMPORTED.address });
    await expect(backupTradingKey(f.w, key)).rejects.toMatchObject({ code: 'upstream_error' });
    expect(f.getActive()).toBe('main');
  });
});

describe('omsSigner', () => {
  it('adds EIP712Domain, signs as the target, and restores the active wallet', async () => {
    const f = fakeOms([MAIN, IMPORTED], 'main');
    const signer = omsSigner(f.w, { walletId: 'imp-x', address: IMPORTED.address });
    expect(await signer.getAddress()).toBe(IMPORTED.address);
    const sig = await signer.signTypedData({
      domain: { name: 'X', version: '1', chainId: 137, verifyingContract: MAIN.address },
      primaryType: 'Thing',
      types: { Thing: [{ name: 'a', type: 'uint256' }] },
      message: { a: 1 }
    } as never);
    expect(sig).toBe('0xsig');
    expect(f.signed).toHaveLength(1);
    expect(f.signed[0]!.active).toBe('imp-x');
    const td = (f.signed[0]!.payload as { typedData: { types: Record<string, unknown> } })
      .typedData;
    expect(td.types.EIP712Domain).toEqual([
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' }
    ]);
    expect(f.getActive()).toBe('main');
  });

  it('signMessage signs as the target and restores', async () => {
    const f = fakeOms([MAIN, IMPORTED], 'main');
    const signer = omsSigner(f.w, { walletId: 'imp-x', address: IMPORTED.address });
    expect(await signer.signMessage('0x1234' as never)).toBe('0xmsg');
    expect(f.signed[0]!.active).toBe('imp-x');
    expect(f.getActive()).toBe('main');
  });

  it('sendTransaction throws invalid_input', async () => {
    const f = fakeOms([MAIN, IMPORTED], 'main');
    const signer = omsSigner(f.w, { walletId: 'imp-x', address: IMPORTED.address });
    await expect(signer.sendTransaction({} as never)).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('gasless only')
    });
  });
});

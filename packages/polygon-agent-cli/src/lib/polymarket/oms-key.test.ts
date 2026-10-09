import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import type { OmsWalletLike } from './oms-key.ts';

import { CliError } from '../errors.ts';
import {
  backupTradingKey,
  findTradingKeyWallet,
  omsSigner,
  selectMainWallet,
  TRADING_KEY_REFERENCE,
  tradingKeyReference,
  withActiveWallet
} from './oms-key.ts';

interface FakeAccount {
  id: string;
  type: 'ethereum';
  address: string;
  reference?: string;
  keyOrigin: 'enclave' | 'imported';
  key: `0x${string}`;
}

const mkAccount = (
  id: string,
  keyOrigin: 'enclave' | 'imported',
  reference?: string
): FakeAccount => {
  const key = generatePrivateKey();
  return {
    id,
    type: 'ethereum',
    address: privateKeyToAccount(key).address,
    reference,
    keyOrigin,
    key
  };
};

function fakeOms(
  initial: FakeAccount[],
  activeId: string | undefined,
  opts: { importAddress?: string; signWith?: `0x${string}`; delayMs?: number } = {}
) {
  const wallets = [...initial];
  let active = activeId;
  const calls: string[] = [];
  const imports: Array<Record<string, unknown>> = [];
  const signed: Array<{ active: string | undefined; payload: unknown }> = [];
  const byId = (id: string) => wallets.find((x) => x.id === id)!;
  const signer = () => privateKeyToAccount(opts.signWith ?? byId(active!).key);
  const tick = () => new Promise((r) => setTimeout(r, opts.delayMs ?? 0));
  const strip = ({ key: _key, ...rest }: FakeAccount) => rest;
  const w = {
    get walletAddress() {
      return active ? byId(active).address : undefined;
    },
    async listWallets() {
      await tick();
      return wallets.map(strip);
    },
    async useWallet({ walletId }: { walletId: string }) {
      calls.push(`use:${walletId}`);
      await tick();
      active = walletId;
      return { walletAddress: byId(walletId).address, wallet: strip(byId(walletId)) };
    },
    async importWallet(p: { privateKey: string; reference?: string; type: string }) {
      calls.push('import');
      imports.push({ type: p.type, reference: p.reference });
      const address =
        opts.importAddress ?? privateKeyToAccount(p.privateKey as `0x${string}`).address;
      const acct: FakeAccount = {
        id: `imp-${wallets.length}`,
        type: 'ethereum',
        address,
        reference: p.reference,
        keyOrigin: 'imported',
        key: p.privateKey as `0x${string}`
      };
      wallets.push(acct);
      active = acct.id;
      return { walletAddress: address, wallet: strip(acct) };
    },
    async signTypedData(p: { typedData: never }) {
      await tick();
      signed.push({ active, payload: p });
      return signer().signTypedData(p.typedData);
    },
    async signMessage(p: { message: string }) {
      await tick();
      signed.push({ active, payload: p });
      return signer().signMessage({ message: p.message });
    }
  };
  return { w: w as unknown as OmsWalletLike, calls, imports, signed, getActive: () => active };
}

const MAIN = mkAccount('main', 'enclave');
const IMPORTED = mkAccount('imp-x', 'imported', 'other');
const REF_A = tradingKeyReference('install-a');
const TK = mkAccount('imp-tk', 'imported', REF_A);
// Backed up before references were per install: the bare prefix.
const BARE = mkAccount('imp-bare', 'imported', TRADING_KEY_REFERENCE);

describe('selectMainWallet', () => {
  it('picks the expected address case-insensitively and switches to it', async () => {
    const f = fakeOms([IMPORTED, MAIN], 'imp-x');
    const r = await selectMainWallet(f.w, { expectedAddress: MAIN.address.toLowerCase() });
    expect(r).toEqual({ id: 'main', address: MAIN.address });
    expect(f.getActive()).toBe('main');
  });

  it('never selects an imported wallet, even by expected address', async () => {
    const f = fakeOms([MAIN, IMPORTED], 'main');
    await expect(
      selectMainWallet(f.w, { expectedAddress: IMPORTED.address })
    ).rejects.toMatchObject({ code: 'not_connected' });
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

describe('tradingKeyReference', () => {
  it('labels the key with the install name under the prefix', () => {
    expect(tradingKeyReference('laptop')).toBe('polymarket-trading-key:laptop');
  });

  it('lower-cases and replaces characters outside [a-z0-9._-]', () => {
    expect(tradingKeyReference('James MacBook Pro/2')).toBe(
      'polymarket-trading-key:james-macbook-pro-2'
    );
    expect(tradingKeyReference('Muse_1.local')).toBe('polymarket-trading-key:muse_1.local');
  });

  it('trims long names so the whole reference fits in 64 characters', () => {
    const ref = tradingKeyReference('x'.repeat(200));
    expect(ref).toHaveLength(64);
    expect(ref.startsWith('polymarket-trading-key:')).toBe(true);
  });
});

describe('findTradingKeyWallet', () => {
  it('matches an imported wallet by exact address, whatever its reference', async () => {
    const f = fakeOms([MAIN, IMPORTED, TK, BARE], 'main');
    expect(await findTradingKeyWallet(f.w, { address: IMPORTED.address.toLowerCase() })).toEqual({
      id: 'imp-x',
      address: IMPORTED.address
    });
    expect(await findTradingKeyWallet(f.w, { address: BARE.address })).toEqual({
      id: 'imp-bare',
      address: BARE.address
    });
  });

  it('matches by exact reference only', async () => {
    const f = fakeOms([MAIN, IMPORTED, TK, BARE], 'main');
    expect(await findTradingKeyWallet(f.w, { reference: REF_A })).toEqual({
      id: 'imp-tk',
      address: TK.address
    });
    expect(
      await findTradingKeyWallet(f.w, { reference: tradingKeyReference('install-b') })
    ).toBeNull();
  });

  it('never finds a bare-prefix key by reference', async () => {
    const f = fakeOms([MAIN, BARE], 'main');
    expect(
      await findTradingKeyWallet(f.w, { reference: tradingKeyReference('install-a') })
    ).toBeNull();
    expect(await findTradingKeyWallet(f.w, {})).toBeNull();
  });

  it('picks the newest key with the reference when OMS holds several', async () => {
    const NEWER = mkAccount('imp-tk2', 'imported', REF_A);
    const f = fakeOms([MAIN, TK, IMPORTED, NEWER], 'main');
    expect(await findTradingKeyWallet(f.w, { reference: REF_A })).toEqual({
      id: 'imp-tk2',
      address: NEWER.address
    });
  });

  it('does not match by reference when an address is given and differs', async () => {
    const f = fakeOms([MAIN, TK], 'main');
    expect(
      await findTradingKeyWallet(f.w, { address: IMPORTED.address, reference: REF_A })
    ).toBeNull();
  });

  it('never returns the main wallet', async () => {
    const f = fakeOms([MAIN, TK], 'main');
    expect(await findTradingKeyWallet(f.w, { address: MAIN.address })).toBeNull();
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

  it('restores to the main wallet when there was no active wallet', async () => {
    const f = fakeOms([IMPORTED, MAIN], undefined);
    await withActiveWallet(f.w, 'imp-x', async () => {
      expect(f.getActive()).toBe('imp-x');
    });
    expect(f.getActive()).toBe('main');
  });

  it('restores to the main wallet when the previous active wallet was an imported key', async () => {
    const f = fakeOms([MAIN, IMPORTED, TK], 'imp-x');
    await withActiveWallet(f.w, 'imp-tk', async () => {
      expect(f.getActive()).toBe('imp-tk');
    });
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
    const first = await backupTradingKey(f.w, key, REF_A);
    expect(first).toMatchObject({ address, imported: true });
    expect(f.getActive()).toBe('main');
    expect(f.calls.filter((c) => c === 'import')).toHaveLength(1);

    const second = await backupTradingKey(f.w, key, REF_A);
    expect(second).toEqual({ omsWalletId: first.omsWalletId, address, imported: false });
    expect(f.calls.filter((c) => c === 'import')).toHaveLength(1);
    expect(f.getActive()).toBe('main');
  });

  it('imports with the given install reference', async () => {
    const f = fakeOms([MAIN], 'main');
    await backupTradingKey(f.w, key, REF_A);
    expect(f.imports).toEqual([
      { type: 'ethereum', reference: 'polymarket-trading-key:install-a' }
    ]);
    expect(TRADING_KEY_REFERENCE).toBe('polymarket-trading-key');
  });

  it('restores to the main wallet when there was no active wallet', async () => {
    const f = fakeOms([MAIN], undefined);
    await backupTradingKey(f.w, key, REF_A);
    expect(f.getActive()).toBe('main');
  });

  it('restores to the main wallet when the previous active wallet was an imported key', async () => {
    const f = fakeOms([MAIN, IMPORTED], 'imp-x');
    await backupTradingKey(f.w, key, REF_A);
    expect(f.getActive()).toBe('main');
  });

  it('throws upstream_error on an address mismatch and still restores the wallet', async () => {
    const f = fakeOms([MAIN], 'main', { importAddress: IMPORTED.address });
    await expect(backupTradingKey(f.w, key, REF_A)).rejects.toMatchObject({
      code: 'upstream_error'
    });
    expect(f.getActive()).toBe('main');
  });
});

describe('omsSigner', () => {
  const typed = {
    domain: { name: 'X', version: '1', chainId: 137, verifyingContract: MAIN.address },
    primaryType: 'Thing',
    types: { Thing: [{ name: 'a', type: 'uint256' }] },
    message: { a: 1n }
  } as never;

  it('adds EIP712Domain, signs as the target, and restores the active wallet', async () => {
    const f = fakeOms([MAIN, IMPORTED], 'main');
    const signer = omsSigner(f.w, { walletId: 'imp-x', address: IMPORTED.address });
    expect(await signer.getAddress()).toBe(IMPORTED.address);
    const sig = await signer.signTypedData(typed);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
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
    expect(await signer.signMessage('0x1234' as never)).toMatch(/^0x/);
    expect(f.signed[0]!.active).toBe('imp-x');
    expect(f.getActive()).toBe('main');
  });

  it('concurrent signatures are each signed as the target and the session ends on main', async () => {
    const f = fakeOms([MAIN, IMPORTED], 'main', { delayMs: 2 });
    const signer = omsSigner(f.w, { walletId: 'imp-x', address: IMPORTED.address });
    await Promise.all([signer.signTypedData(typed), signer.signMessage('0x1234' as never)]);
    expect(f.signed.map((x) => x.active)).toEqual(['imp-x', 'imp-x']);
    expect(f.getActive()).toBe('main');
  });

  it('throws upstream_error when the signature was made by a different wallet', async () => {
    const f = fakeOms([MAIN, IMPORTED], 'main', { signWith: MAIN.key });
    const signer = omsSigner(f.w, { walletId: 'imp-x', address: IMPORTED.address });
    await expect(signer.signTypedData(typed)).rejects.toMatchObject({ code: 'upstream_error' });
    await expect(signer.signMessage('0x1234' as never)).rejects.toMatchObject({
      code: 'upstream_error'
    });
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

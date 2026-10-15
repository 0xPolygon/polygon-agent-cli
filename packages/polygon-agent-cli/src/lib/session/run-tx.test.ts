import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { encodeFunctionData, erc20Abi, getAddress } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as RunTx from './run-tx.ts';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-runtx-'));

const mocks = vi.hoisted(() => ({ runOmsTx: vi.fn(), runSessionTx: vi.fn() }));
vi.mock('../oms-tx.ts', () => ({ runOmsTx: mocks.runOmsTx }));
vi.mock('./run-tx.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof RunTx>()),
  runSessionTx: mocks.runSessionTx
}));

const { decodeSessionTransfer } = await import('./run-tx.ts');
const { runTx } = await import('../tx-dispatch.ts');
const { saveOmsWalletPointer } = await import('../storage.ts');

const USDC = getAddress('0x3c499c542cef5e3811e1192ce70d8cc03d5c3359');
const TO = getAddress('0x1D17C0F90A0b3dFb5124C2FF56B33a0D2E202e1d');
const transfer = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [TO, 5n] });
const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TO, 5n] });

const tx = (overrides: Record<string, unknown> = {}) => ({
  walletName: 'w',
  chainId: 137,
  broadcast: true,
  transactions: [{ to: USDC, data: transfer, value: 0n, ...overrides }]
});

describe('decodeSessionTransfer', () => {
  it('accepts exactly one ERC-20 transfer', () => {
    expect(decodeSessionTransfer(tx())).toEqual({ token: USDC, to: TO, amount: 5n });
  });

  it('refuses native value', () => {
    expect(() => decodeSessionTransfer(tx({ value: 1n }))).toThrow(
      expect.objectContaining({ code: 'native_not_supported' })
    );
  });

  it.each([
    ['an approve', tx({ data: approve })],
    ['arbitrary calldata', tx({ data: '0xdeadbeef' })],
    ['a bad address', tx({ to: 'nope' })],
    ['two transactions', { ...tx(), transactions: [...tx().transactions, ...tx().transactions] }]
  ])('needs the owner for %s', (_label, params) => {
    expect(() => decodeSessionTransfer(params)).toThrow(
      expect.objectContaining({ code: 'owner_required' })
    );
  });
});

describe('runTx routing', () => {
  afterEach(() => vi.clearAllMocks());

  it('owner-mode wallets (and pointers without access) use the owner path', async () => {
    await saveOmsWalletPointer('owner', {
      walletAddress: TO,
      loginMethod: 'google',
      createdAt: 'x'
    });
    await runTx({ ...tx(), walletName: 'owner' });
    expect(mocks.runOmsTx).toHaveBeenCalledTimes(1);
    expect(mocks.runSessionTx).not.toHaveBeenCalled();
  });

  it('session-mode wallets go through the session path with the wallet address', async () => {
    await saveOmsWalletPointer('sess', {
      walletAddress: TO,
      loginMethod: 'email',
      createdAt: 'x',
      access: 'session'
    });
    await runTx({ ...tx(), walletName: 'sess', purpose: 'trade' });
    expect(mocks.runSessionTx).toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress: TO, purpose: 'trade' })
    );
    expect(mocks.runOmsTx).not.toHaveBeenCalled();
  });

  it('owner-only spends are refused in session mode', async () => {
    await saveOmsWalletPointer('sess2', {
      walletAddress: TO,
      loginMethod: 'email',
      createdAt: 'x',
      access: 'session'
    });
    await expect(runTx({ ...tx(), walletName: 'sess2', ownerOnly: true })).rejects.toMatchObject({
      code: 'owner_required'
    });
    expect(mocks.runSessionTx).not.toHaveBeenCalled();
  });
});

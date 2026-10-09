import { describe, expect, it, vi } from 'vitest';

import type { FeeOptionWithBalance } from '@polygonlabs/oms-wallet';

const MAIN = '0xC2F4cAfe89AE7e1bcB86dd3f141C0a3adCEB6C17';
const IMPORTED = '0x1111111111111111111111111111111111111111';
const oms = vi.hoisted(() => {
  const state = { walletAddress: '0xC2F4cAfe89AE7e1bcB86dd3f141C0a3adCEB6C17' as string };
  return {
    state,
    sendTransaction: vi.fn(),
    sentFrom: [] as string[],
    listWallets: vi.fn(),
    useWallet: vi.fn()
  };
});
vi.mock('./oms-client.ts', () => ({
  getOmsClient: () => ({
    wallet: {
      get walletAddress() {
        return oms.state.walletAddress;
      },
      sendTransaction: oms.sendTransaction,
      listWallets: oms.listWallets,
      useWallet: oms.useWallet
    }
  })
}));
vi.mock('./storage.ts', () => ({
  loadOmsWalletPointer: async () => ({
    walletAddress: '0xC2F4cAfe89AE7e1bcB86dd3f141C0a3adCEB6C17',
    loginMethod: 'email',
    createdAt: ''
  })
}));

const { makeFeeSelector, runOmsTx } = await import('./oms-tx.ts');

function option(params: {
  symbol: string;
  contractAddress?: string;
  value: string;
  availableRaw?: string;
  index: number;
}): FeeOptionWithBalance {
  return {
    feeOption: {
      token: {
        network: '137',
        name: params.symbol,
        symbol: params.symbol,
        type: params.contractAddress ? 'erc20' : 'native',
        contractAddress: params.contractAddress
      },
      value: params.value,
      displayValue: params.value
    },
    selection: { token: params.symbol, index: params.index },
    availableRaw: params.availableRaw
  };
}

const USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';

describe('makeFeeSelector', () => {
  it('returns undefined for a sponsored transaction (empty list)', () => {
    expect(makeFeeSelector(false)([])).toBeUndefined();
    expect(makeFeeSelector(true)([])).toBeUndefined();
  });

  it('prefers affordable USDC and returns the SDK selection with its index', () => {
    const opts = [
      option({ symbol: 'POL', value: '10', availableRaw: '100', index: 0 }),
      option({ symbol: 'USDC', contractAddress: USDC, value: '5', availableRaw: '50', index: 1 })
    ];
    expect(makeFeeSelector(false)(opts)).toEqual({ token: 'USDC', index: 1 });
  });

  it('prefers native when asked', () => {
    const opts = [
      option({ symbol: 'USDC', contractAddress: USDC, value: '5', availableRaw: '50', index: 0 }),
      option({ symbol: 'POL', value: '10', availableRaw: '100', index: 1 })
    ];
    expect(makeFeeSelector(true)(opts)).toEqual({ token: 'POL', index: 1 });
  });

  it('throws when no option is affordable', () => {
    const opts = [
      option({ symbol: 'USDC', contractAddress: USDC, value: '5', availableRaw: '1', index: 0 })
    ];
    expect(() => makeFeeSelector(false)(opts)).toThrow(
      expect.objectContaining({
        code: 'insufficient_balance',
        message: expect.stringMatching(/Unable to pay gas/),
        hint: expect.stringMatching(/agent fund/)
      })
    );
  });
});

describe('runOmsTx wallet guard', () => {
  it('switches a session left on the imported wallet back to main before sending', async () => {
    oms.state.walletAddress = IMPORTED;
    oms.listWallets.mockResolvedValue([
      { id: 'w-imp', address: IMPORTED, keyOrigin: 'imported' },
      { id: 'w-main', address: MAIN, keyOrigin: 'generated' }
    ]);
    oms.useWallet.mockImplementation(async ({ walletId }: { walletId: string }) => {
      oms.state.walletAddress = walletId === 'w-main' ? MAIN : IMPORTED;
    });
    oms.sentFrom.length = 0;
    oms.sendTransaction.mockImplementation(async () => {
      oms.sentFrom.push(oms.state.walletAddress);
      return { txnHash: '0xok' };
    });
    const result = await runOmsTx({
      walletName: 'main',
      chainId: 137,
      transactions: [{ to: USDC, data: '0x' }],
      broadcast: true
    });
    expect(oms.useWallet).toHaveBeenCalledWith({ walletId: 'w-main' });
    expect(oms.sentFrom).toEqual([MAIN]);
    expect(result.walletAddress).toBe(MAIN);
  });

  it('refuses to send when the pointer wallet is not on the account', async () => {
    oms.state.walletAddress = IMPORTED;
    oms.sendTransaction.mockClear();
    oms.listWallets.mockResolvedValue([{ id: 'w-imp', address: IMPORTED, keyOrigin: 'imported' }]);
    await expect(
      runOmsTx({
        walletName: 'main',
        chainId: 137,
        transactions: [{ to: USDC, data: '0x' }],
        broadcast: true
      })
    ).rejects.toMatchObject({ code: 'not_connected' });
    expect(oms.sendTransaction).not.toHaveBeenCalled();
    oms.state.walletAddress = MAIN;
  });
});

describe('runOmsTx', () => {
  it('surfaces an unaffordable fee as insufficient_balance even though the SDK wraps it', async () => {
    // The SDK calls the selector before executing and wraps whatever it throws.
    oms.sendTransaction.mockImplementation(
      async (p: { selectFeeOption: (o: FeeOptionWithBalance[]) => unknown }) => {
        try {
          p.selectFeeOption([
            option({
              symbol: 'USDC',
              contractAddress: USDC,
              value: '5',
              availableRaw: '1',
              index: 0
            })
          ]);
        } catch (cause) {
          throw Object.assign(new Error('wrapped by the SDK'), { cause });
        }
        return { txnHash: '0xnever' };
      }
    );
    await expect(
      runOmsTx({
        walletName: 'main',
        chainId: 137,
        transactions: [{ to: USDC, data: '0x' }],
        broadcast: true
      })
    ).rejects.toMatchObject({ code: 'insufficient_balance' });
  });
});

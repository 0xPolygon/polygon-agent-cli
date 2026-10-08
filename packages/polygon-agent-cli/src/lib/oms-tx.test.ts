import { describe, expect, it, vi } from 'vitest';

import type { FeeOptionWithBalance } from '@polygonlabs/oms-wallet';

const oms = vi.hoisted(() => ({ sendTransaction: vi.fn() }));
vi.mock('./oms-client.ts', () => ({
  getOmsClient: () => ({
    wallet: { walletAddress: '0xC2F4cAfe89AE7e1bcB86dd3f141C0a3adCEB6C17', ...oms }
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

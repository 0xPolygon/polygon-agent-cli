import { encodeFunctionData, erc20Abi } from 'viem';
import { describe, expect, it } from 'vitest';

import type { TrailsApi } from '@0xtrails/api';

import type { TradeDeps, TradeRecord } from './trade.ts';

import { MoneyError } from './errors.ts';
import { fakeEngine, START, USDC, WALLET, WETH } from './test-fakes.ts';
import { describeTrade, executeSwap, quoteSwap, tokenUnits } from './trade.ts';

const DEPOSIT_ADDRESS = '0x00000000000000000000000000000000000000d1';

function intent(overrides: Record<string, unknown> = {}, amount = 10_000_000n) {
  return {
    intentId: 'intent-1',
    ownerAddress: WALLET,
    originChainId: 137,
    destinationChainId: 137,
    originTokenAddress: USDC,
    destinationTokenAddress: WETH,
    originIntentAddress: DEPOSIT_ADDRESS,
    depositTransaction: {
      chainId: 137,
      to: USDC,
      value: 0n,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [DEPOSIT_ADDRESS, amount]
      })
    },
    quoteRequest: {
      destinationToAddress: WALLET,
      originTokenAmount: amount,
      tradeType: 'EXACT_INPUT'
    },
    quote: {
      fromAmount: amount,
      toAmount: 4_000_000_000_000_000n,
      toAmountMin: 3_990_000_000_000_000n,
      fromAmountUsd: 10,
      toAmountUsd: 9.95
    },
    fees: { totalFeeUsd: 0.05 },
    expiresAt: new Date(START.getTime() + 10 * 60_000).toISOString(),
    ...overrides
  };
}

function setup(quoted = intent()) {
  const fake = fakeEngine({ statuses: [{ status: 'executed', txnHash: `0x${'ab'.repeat(32)}` }] });
  const trades = new Map<string, TradeRecord>();
  const trailsCalls: string[] = [];
  let receipt: { status: string } = { status: 'QUOTED' };
  const trails = {
    quoteIntent: async () => {
      trailsCalls.push('quote');
      return { intent: quoted };
    },
    getIntentReceipt: async () => {
      trailsCalls.push('receipt');
      return {
        intentReceipt: {
          ...receipt,
          summary: { destinationTokenAmount: 4_000_000_000_000_000n },
          destinationTransaction: { txnHash: '0xdest' }
        }
      };
    },
    executeIntent: async () => {
      trailsCalls.push('execute');
      receipt = { status: 'SUCCEEDED' };
      return { intentStatus: 'EXECUTING' };
    }
  } as unknown as TrailsApi;
  const deps: TradeDeps = {
    ...fake.deps,
    trails,
    trades: {
      trade: async (id) => trades.get(id) ?? null,
      putTrade: async (t) => void trades.set(t.intentId, t)
    },
    waitForReceipt: async () => 'success'
  };
  return { fake, deps, trades, trailsCalls };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (error) {
    if (error instanceof MoneyError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('tokenUnits', () => {
  it('reads decimal amounts and refuses too much precision', () => {
    expect(tokenUnits('1.5', 6)).toBe(1_500_000n);
    expect(() => tokenUnits('1.1234567', 6)).toThrow(MoneyError);
    expect(() => tokenUnits('0', 6)).toThrow(MoneyError);
    expect(() => tokenUnits('-1', 6)).toThrow(MoneyError);
    expect(() => tokenUnits('1e6', 6)).toThrow(MoneyError);
  });
});

describe('swaps', () => {
  it('quotes without sending, then deposits exactly the quote and executes it', async () => {
    const { fake, deps, trailsCalls } = setup();
    const { trade } = await quoteSwap({ from: 'USDC', to: 'ETH', amount: '10' }, deps);
    expect(trade).toMatchObject({ state: 'quoted', destination: { symbol: 'WETH' } });
    expect(fake.calls.prepare).toBe(0);

    const done = await executeSwap(deps, trade.intentId, { send: true });
    expect(done.state).toBe('completed');
    expect(describeTrade(done)).toMatchObject({
      status: 'completed',
      from: { amount: '10', token: 'USDC', chain: 'Polygon' },
      to: { received: '0.004', token: 'WETH' },
      txHash: '0xdest'
    });
    expect(fake.calls.prepare).toBe(1);
    expect(fake.calls.prepared[0].data).toBe(intent().depositTransaction.data);
    expect(trailsCalls).toContain('execute');
  });

  it('refuses a quote whose deposit goes anywhere but the intent address', async () => {
    const other = intent();
    other.depositTransaction = {
      ...other.depositTransaction,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: ['0x00000000000000000000000000000000000000ee', 10_000_000n]
      })
    };
    const { deps } = setup(other);
    expect(await code(quoteSwap({ from: 'USDC', to: 'ETH', amount: '10' }, deps))).toBe(
      'upstream_invalid_quote'
    );
  });

  it('refuses a quote that sends the output elsewhere', async () => {
    const { deps } = setup(
      intent({
        quoteRequest: {
          destinationToAddress: '0x00000000000000000000000000000000000000ee',
          originTokenAmount: 10_000_000n
        }
      })
    );
    expect(await code(quoteSwap({ from: 'USDC', to: 'ETH', amount: '10' }, deps))).toBe(
      'upstream_invalid_quote'
    );
  });

  it('refuses a minimum output below the slippage asked for', async () => {
    const { deps } = setup(
      intent({
        quote: { toAmount: 4_000_000_000_000_000n, toAmountMin: 3_000_000_000_000_000n }
      })
    );
    expect(await code(quoteSwap({ from: 'USDC', to: 'ETH', amount: '10' }, deps))).toBe(
      'upstream_invalid_quote'
    );
  });

  it('only trades covered tokens', async () => {
    const { deps } = setup();
    expect(await code(quoteSwap({ from: 'USDC', to: 'PEPE', amount: '10' }, deps))).toBe(
      'not_covered'
    );
  });

  it("won't execute an expired quote", async () => {
    const { fake, deps } = setup();
    const { trade } = await quoteSwap({ from: 'USDC', to: 'ETH', amount: '10' }, deps);
    fake.advance(6 * 60_000);
    expect(await code(executeSwap(deps, trade.intentId, { send: true }))).toBe('quote_expired');
    expect(fake.calls.prepare).toBe(0);
  });

  it('reopens the quote when the deposit was refused before anything was sent', async () => {
    const { fake, deps, trades } = setup();
    const { trade } = await quoteSwap({ from: 'USDC', to: 'ETH', amount: '10' }, deps);
    fake.state.balance = 0n;
    expect(await code(executeSwap(deps, trade.intentId, { send: true }))).toBe(
      'insufficient_balance'
    );
    expect(trades.get(trade.intentId)?.state).toBe('quoted');
  });

  it('swap_status never sends', async () => {
    const { fake, deps } = setup();
    const { trade } = await quoteSwap({ from: 'USDC', to: 'ETH', amount: '10' }, deps);
    const status = await executeSwap(deps, trade.intentId, { send: false });
    expect(status.state).toBe('quoted');
    expect(fake.calls.prepare).toBe(0);
  });

  it('says when a quote is unknown', async () => {
    const { deps } = setup();
    expect(await code(executeSwap(deps, 'nope', { send: true }))).toBe('quote_not_found');
  });
});

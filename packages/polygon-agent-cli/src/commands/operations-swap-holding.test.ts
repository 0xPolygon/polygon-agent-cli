// The swap command never executes, in one step, a trade paying with a holding
// the user didn't name: it shows the quote and the command to accept it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Quote from '../lib/trade/quote.ts';
import type { TradeRecord } from '../lib/trade/state.ts';

import { swapCommand } from './operations.ts';

const mocks = vi.hoisted(() => ({ quoteSwap: vi.fn(), executeSwap: vi.fn() }));

vi.mock('../lib/trade/quote.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Quote>()),
  quoteSwap: mocks.quoteSwap
}));
vi.mock('../lib/trade/execute.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  executeSwap: mocks.executeSwap
}));
vi.mock('../lib/mode.ts', () => ({
  resolveBroadcast: (argv: { broadcast?: boolean }) => argv.broadcast === true,
  withWriteFlags: vi.fn()
}));
vi.mock('../ui/render.js', () => ({ isTTY: vi.fn(), inkRender: vi.fn() }));
vi.mock('./operations-ui.js', () => ({ BalancesUI: vi.fn(), FundUI: vi.fn(), SendUI: vi.fn() }));

const trade: TradeRecord = {
  intentId: 'intent-1',
  walletName: 'main',
  walletAddress: '0xd384ea24ca0B3a5e4BB35935C611E3dCB68Fd08e',
  // Owner mode, so a dry run has no allowance to check.
  mode: 'owner',
  state: 'quoted',
  origin: {
    chainId: 137,
    chain: 'Polygon',
    token: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    symbol: 'WETH',
    decimals: 18,
    amount: '4000000000000000'
  },
  destination: {
    chainId: 137,
    chain: 'Polygon',
    token: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    symbol: 'WPOL',
    decimals: 18,
    expectedAmount: '100000000000000000000',
    minAmount: '99500000000000000000'
  },
  quote: {
    fromAmountUsd: 10,
    toAmountUsd: 9.95,
    totalFeeUsd: 0.02,
    priceImpact: 0.001,
    slippage: 0.005,
    routeProviders: ['SUSHI'],
    intentExpiresAt: new Date(Date.now() + 600_000).toISOString()
  },
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
  deposit: { to: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', data: '0x', value: '0' },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};
const warning = 'No covered stablecoin holds enough, so this pays with 0.004 WETH (about $10.00).';

async function swap(overrides: Record<string, unknown> = {}) {
  if (typeof swapCommand.handler !== 'function') throw new Error('Missing swap handler');
  await swapCommand.handler({
    _: [],
    $0: 'polygon-agent',
    to: 'POL',
    'amount-usd': 10,
    broadcast: true,
    ...overrides
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('CLI exited');
  });
  mocks.quoteSwap.mockResolvedValue({
    trade,
    warnings: [warning],
    highFee: false,
    paidWithHolding: true
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('swap paying with another holding', () => {
  it('asks the swap command to consider other holdings', async () => {
    await swap({ broadcast: false });
    expect(mocks.quoteSwap).toHaveBeenCalledWith(
      expect.objectContaining({ payWithHoldings: true, amountUsd: 10 })
    );
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0][0] as string);
    expect(output).toMatchObject({ ok: true, dryRun: true, warnings: [warning] });
  });

  it('is refused in one step, with the command to accept the quote', async () => {
    await expect(swap()).rejects.toThrow('CLI exited');
    expect(mocks.executeSwap).not.toHaveBeenCalled();
    const output = JSON.parse(vi.mocked(console.error).mock.calls[0][0] as string);
    expect(output).toMatchObject({
      ok: false,
      code: 'confirmation_required',
      command: 'polygon-agent swap --intent intent-1 --broadcast'
    });
    expect(output.error).toContain('pays with 0.004 WETH');
  });

  it('shows an exact-output buy before executing it, with what it costs', async () => {
    mocks.quoteSwap.mockResolvedValue({
      trade,
      warnings: [],
      highFee: false,
      paidWithHolding: false
    });
    await expect(swap({ 'amount-usd': undefined, 'to-amount': '100' })).rejects.toThrow(
      'CLI exited'
    );
    expect(mocks.executeSwap).not.toHaveBeenCalled();
    const output = JSON.parse(vi.mocked(console.error).mock.calls[0][0] as string);
    expect(output).toMatchObject({
      code: 'confirmation_required',
      command: 'polygon-agent swap --intent intent-1 --broadcast'
    });
    expect(output.error).toContain('Buying 100 WPOL costs 0.004 WETH');
  });

  it('passes --to-amount through as the amount to receive', async () => {
    mocks.quoteSwap.mockResolvedValue({
      trade,
      warnings: [],
      highFee: false,
      paidWithHolding: false
    });
    await swap({ 'amount-usd': undefined, 'to-amount': '10', broadcast: false });
    expect(mocks.quoteSwap).toHaveBeenCalledWith(
      expect.objectContaining({ toAmount: '10', amountUsd: undefined })
    );
  });
});

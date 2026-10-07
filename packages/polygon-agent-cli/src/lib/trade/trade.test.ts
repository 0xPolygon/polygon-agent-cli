// The swap core in session mode: token resolution, amounts, the default
// source, and resumable execution that never sends a deposit twice.

import type * as Viem from 'viem';

import { encodeFunctionData, erc20Abi, getAddress } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Sessions from '../session/sessions.ts';
import type * as Storage from '../storage.ts';

const fake = vi.hoisted(() => ({
  quoteIntent: vi.fn(),
  executeIntent: vi.fn(),
  getIntentReceipt: vi.fn(),
  waitIntentReceipt: vi.fn(),
  runTx: vi.fn(),
  tokenBalance: vi.fn(),
  walletHoldings: vi.fn(),
  getSessions: vi.fn(),
  getUsdPrices: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  reconcileTransfers: vi.fn(),
  pointer: {
    walletAddress: '0xd384ea24ca0B3a5e4BB35935C611E3dCB68Fd08e',
    loginMethod: 'email',
    createdAt: 'x',
    access: 'session'
  } as { walletAddress: string; loginMethod: string; createdAt: string; access?: string }
}));

vi.mock('../builder-provision.ts', () => ({
  ensureBuilderAccess: async () => undefined,
  ensureBuilderAccessKey: async () => ({ provisioned: false, reason: 'existing' }),
  makeDefaultProvisionDeps: () => ({}),
  provisionBuilderOnce: async () => ({ provisioned: false, reason: 'existing' })
}));
vi.mock('../storage.ts', async (importOriginal) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  return {
    ...(await importOriginal<typeof Storage>()),
    STORAGE_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'pa-trade-')),
    loadOmsWalletPointer: vi.fn(async () => fake.pointer)
  };
});
vi.mock('../prices.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  trailsClient: async () => ({
    quoteIntent: fake.quoteIntent,
    executeIntent: fake.executeIntent,
    getIntentReceipt: fake.getIntentReceipt,
    waitIntentReceipt: fake.waitIntentReceipt
  }),
  getUsdPrices: fake.getUsdPrices
}));
vi.mock('../session/live.ts', () => ({
  tokenBalance: fake.tokenBalance,
  walletHoldings: fake.walletHoldings,
  liveTransferDeps: () => ({})
}));
vi.mock('../session/transfer.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reconcileTransfers: fake.reconcileTransfers
}));
vi.mock('../session/sessions.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Sessions>()),
  getSessions: fake.getSessions
}));
vi.mock('../session/renewal.ts', () => ({
  withWalletKeys: (params: { fn: () => Promise<unknown> }) => params.fn()
}));
vi.mock('../session/rac.ts', () => ({ racClient: () => ({}) }));
vi.mock('../tx-dispatch.ts', () => ({ runTx: fake.runTx }));
vi.mock('viem', async (importOriginal) => ({
  ...(await importOriginal<typeof Viem>()),
  createPublicClient: () => ({ waitForTransactionReceipt: fake.waitForTransactionReceipt })
}));

const { describeTrade, quoteSwap } = await import('./quote.ts');
const { executeSwap } = await import('./execute.ts');
const { loadTrade, saveTrade } = await import('./state.ts');
const { buildPlan } = await import('../session/plan.ts');
const { sessionDir, writeApprovedPlan, writeJsonFile } = await import('../session/state.ts');
const { supportedTokens } = await import('../session/tokens.ts');
const path = await import('node:path');
const fs = await import('node:fs');

// Where the transfer engine keeps its records (it creates the folder on first use).
const transferFile = (id: string) => {
  const dir = path.join(sessionDir(wallet), 'transfers');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${id}.json`);
};

const WALLET = '0xd384ea24ca0B3a5e4BB35935C611E3dCB68Fd08e';
const USDC = getAddress('0x3c499c542cef5e3811e1192ce70d8cc03d5c3359');
const USDT = getAddress('0xc2132d05d31c914a87c6611c10748aeb04b58e8f');
const WETH = getAddress('0x7ceb23fd6bc0add59e62ac25578270cff1b9f619');
const DEPOSIT = '0x00000000000000000000000000000000000000d0';
const TX = `0x${'ab'.repeat(32)}`;

let counter = 0;
let wallet = 'w';

// A quote for exactly what was asked.
function intentFor(request: {
  originChainId: number;
  originTokenAddress: string;
  originTokenAmount: bigint;
  destinationChainId: number;
  destinationTokenAddress: string;
}) {
  return {
    intent: {
      intentId: `intent-${counter}`,
      ownerAddress: WALLET,
      originChainId: request.originChainId,
      destinationChainId: request.destinationChainId,
      originTokenAddress: request.originTokenAddress,
      destinationTokenAddress: request.destinationTokenAddress,
      originIntentAddress: DEPOSIT,
      quoteRequest: {
        destinationToAddress: WALLET,
        originTokenAmount: request.originTokenAmount,
        tradeType: 'EXACT_INPUT'
      },
      depositTransaction: {
        chainId: request.originChainId,
        to: request.originTokenAddress,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: [DEPOSIT, request.originTokenAmount]
        })
      },
      quote: {
        fromAmountUsd: 1,
        toAmount: 390_000_000_000_000n,
        toAmountMin: 388_100_000_000_000n,
        toAmountUsd: 0.99,
        priceImpact: 0.001,
        routeProviders: ['SUSHI']
      },
      fees: { totalFeeUsd: 0.01 },
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
    }
  };
}

function transferRecord(params: { id: string; ref: string; patch: Record<string, unknown> }) {
  writeJsonFile({
    file: transferFile(params.id),
    data: {
      id: params.id,
      state: 'failed',
      chainId: 137,
      token: USDC,
      symbol: 'USDC',
      to: DEPOSIT,
      amount: '1000000',
      usd: 1,
      purpose: 'trade',
      ref: params.ref,
      walletId: 'w',
      sessionId: 's',
      txnId: 'txn',
      ledgered: false,
      createdAt: 'x',
      updatedAt: 'x',
      ...params.patch
    }
  });
}

function balances(entries: Array<{ chainId: number; token: string; balance: bigint }>) {
  fake.walletHoldings.mockResolvedValue({
    balances: entries.map((e) => ({
      chainId: e.chainId,
      contractAddress: e.token,
      balance: e.balance.toString()
    }))
  });
}

function sessionWith(remaining: Record<string, bigint>) {
  fake.getSessions.mockResolvedValue([
    {
      chainId: 137,
      sessionId: 's',
      walletId: 'w',
      expiresAt: '2099-01-01T00:00:00Z',
      expired: false,
      grants: Object.entries(remaining).map(([token, left]) => ({
        token,
        limit: 10n ** 30n,
        used: 0n,
        remaining: left
      }))
    }
  ]);
}

const quote = (overrides: Record<string, unknown> = {}) =>
  quoteSwap({ walletName: wallet, to: 'ETH', amount: '1', now: new Date(), ...overrides });

beforeEach(() => {
  vi.resetAllMocks();
  wallet = `w${++counter}`;
  const tokens = supportedTokens(137).map((t) => ({ chainId: 137, ...t }));
  writeApprovedPlan({
    wallet,
    approved: {
      plan: buildPlan({
        allowanceUsd: 100,
        days: 30,
        tokens,
        prices: new Map(
          tokens
            .filter((t) => t.kind !== 'usd')
            .map((t) => [`137:${t.address.toLowerCase()}`, 2500])
        ),
        now: new Date()
      }),
      approvedAt: new Date().toISOString()
    }
  });
  fake.pointer = {
    walletAddress: WALLET,
    loginMethod: 'email',
    createdAt: 'x',
    access: 'session'
  };
  fake.reconcileTransfers.mockResolvedValue(undefined);
  fake.quoteIntent.mockImplementation(async (request) => intentFor(request));
  balances([{ chainId: 137, token: USDC, balance: 50_000_000n }]);
  sessionWith({ [USDC]: 100_000_000n, [USDT]: 100_000_000n });
  fake.tokenBalance.mockResolvedValue(8_000_000n);
  fake.getUsdPrices.mockResolvedValue(new Map([[`137:${WETH.toLowerCase()}`, 2500]]));
  fake.runTx.mockResolvedValue({ txHash: TX });
  fake.waitForTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: TX });
  fake.getIntentReceipt.mockRejectedValue(new Error('not found'));
  fake.executeIntent.mockResolvedValue({ intentStatus: 'EXECUTING' });
  fake.waitIntentReceipt.mockResolvedValue({
    done: true,
    intentReceipt: {
      status: 'SUCCEEDED',
      destinationTransaction: { txnHash: '0xdest' },
      summary: { destinationTokenAmount: 390_000_000_000_000n }
    }
  });
});

describe('quoteSwap in session mode', () => {
  it('buys of ETH deliver the covered WETH, paid from USDC on Polygon by default', async () => {
    const { trade } = await quote();
    expect(trade).toMatchObject({
      state: 'quoted',
      mode: 'session',
      origin: { chainId: 137, symbol: 'USDC', amount: '1000000' },
      destination: { chainId: 137, symbol: 'WETH' }
    });
    expect(fake.quoteIntent).toHaveBeenCalledWith(
      expect.objectContaining({ destinationToAddress: WALLET, destinationTokenAddress: WETH })
    );
    expect(loadTrade(trade.intentId)).toEqual(trade);
  });

  it('pays from a chain where the token bought is covered', async () => {
    const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const BASE_WETH = '0x4200000000000000000000000000000000000006';
    const tokens = [
      { chainId: 137, ...supportedTokens(137)[0] },
      ...supportedTokens(8453)
        .filter((t) => t.symbol === 'USDC' || t.symbol === 'WETH')
        .map((t) => ({ chainId: 8453, ...t }))
    ];
    writeApprovedPlan({
      wallet,
      approved: {
        plan: buildPlan({
          allowanceUsd: 100,
          days: 30,
          tokens,
          prices: new Map([[`8453:${BASE_WETH.toLowerCase()}`, 2500]]),
          now: new Date()
        }),
        approvedAt: new Date().toISOString()
      }
    });
    balances([
      { chainId: 137, token: USDC, balance: 50_000_000n },
      { chainId: 8453, token: BASE_USDC, balance: 50_000_000n }
    ]);
    fake.getSessions.mockResolvedValue(
      [137, 8453].map((chainId) => ({
        chainId,
        sessionId: `s${chainId}`,
        walletId: 'w',
        expiresAt: '2099-01-01T00:00:00Z',
        expired: false,
        grants: [
          {
            token: chainId === 137 ? USDC : BASE_USDC,
            limit: 10n ** 30n,
            used: 0n,
            remaining: 10n ** 30n
          }
        ]
      }))
    );
    // WETH isn't covered on Polygon, so Polygon's USDC can't pay for it.
    const { trade } = await quote();
    expect(trade).toMatchObject({
      origin: { chainId: 8453, symbol: 'USDC' },
      destination: { chainId: 8453, symbol: 'WETH' }
    });
  });

  it("maps Trails' own rate-limit and outage errors to retryable codes", async () => {
    const { RateLimitedError, UnavailableError, QueryFailedError } = await import('@0xtrails/api');
    fake.quoteIntent.mockRejectedValueOnce(new RateLimitedError());
    await expect(quote()).rejects.toMatchObject({ code: 'rate_limited' });
    fake.quoteIntent.mockRejectedValueOnce(new UnavailableError());
    await expect(quote()).rejects.toMatchObject({ code: 'upstream_unavailable' });
    const { TimeoutError, WebrpcBadResponseError } = await import('@0xtrails/api');
    fake.quoteIntent.mockRejectedValueOnce(new TimeoutError());
    await expect(quote()).rejects.toMatchObject({ code: 'upstream_unavailable' });
    // A gateway's HTML error page.
    fake.quoteIntent.mockRejectedValueOnce(new WebrpcBadResponseError({ status: 503 }));
    await expect(quote()).rejects.toMatchObject({ code: 'upstream_unavailable' });
    fake.quoteIntent.mockRejectedValueOnce(new WebrpcBadResponseError({ status: 429 }));
    await expect(quote()).rejects.toMatchObject({ code: 'rate_limited' });
    const other = new QueryFailedError();
    fake.quoteIntent.mockRejectedValueOnce(other);
    await expect(quote()).rejects.toBe(other);
  });

  it('falls back to the next stablecoin when USDC lacks the balance or the allowance', async () => {
    balances([
      { chainId: 137, token: USDC, balance: 50_000_000n },
      { chainId: 137, token: USDT, balance: 50_000_000n }
    ]);
    sessionWith({ [USDC]: 500_000n, [USDT]: 100_000_000n });
    const { trade } = await quote();
    expect(trade.origin.symbol).toBe('USDT');
  });

  it('skips a stablecoin whose session is gone, even though it is in the plan', async () => {
    balances([
      { chainId: 137, token: USDC, balance: 50_000_000n },
      { chainId: 137, token: USDT, balance: 50_000_000n }
    ]);
    sessionWith({ [USDT]: 100_000_000n });
    const { trade } = await quote();
    expect(trade.origin.symbol).toBe('USDT');
  });

  it('insufficient_balance when no covered stablecoin can pay', async () => {
    balances([{ chainId: 137, token: USDC, balance: 100n }]);
    await expect(quote()).rejects.toMatchObject({ code: 'insufficient_balance' });
    expect(fake.quoteIntent).not.toHaveBeenCalled();
  });

  it('sells a share of the balance with --amount <n>%', async () => {
    const { trade } = await quote({ from: 'USDC', to: 'WETH', amount: '25%' });
    expect(trade.origin.amount).toBe('2000000');
  });

  it('converts --amount-usd at the current price, rounding down', async () => {
    const { trade } = await quote({ from: 'WETH', to: 'USDC', amount: undefined, amountUsd: 10 });
    expect(trade.origin.amount).toBe('4000000000000000');
  });

  it('refuses the native coin as a source, and uncovered destinations', async () => {
    await expect(quote({ from: 'POL', to: 'USDC' })).rejects.toMatchObject({
      code: 'native_not_supported'
    });
    await expect(quote({ to: 'LINK' })).rejects.toMatchObject({
      code: 'not_covered',
      command: expect.stringContaining('allowance set --add LINK@')
    });
    await expect(quote({ to: 'WETH', toChain: 'arbitrum' })).rejects.toMatchObject({
      code: 'not_covered'
    });
  });

  it('refuses slippage above max_slippage, and needs exactly one amount', async () => {
    await expect(quote({ slippage: 0.05 })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(quote({ amountUsd: 5 })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('refuses a quote whose deposit differs from the request', async () => {
    fake.quoteIntent.mockImplementation(async (request) => {
      const res = intentFor(request);
      res.intent.depositTransaction.data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [DEPOSIT, request.originTokenAmount + 1n]
      });
      return res;
    });
    await expect(quote()).rejects.toMatchObject({ code: 'upstream_invalid_quote' });
  });

  it('warns when fees are over 10% of the trade', async () => {
    fake.quoteIntent.mockImplementation(async (request) => {
      const res = intentFor(request);
      res.intent.fees.totalFeeUsd = 0.2;
      return res;
    });
    const { warnings } = await quote();
    expect(warnings).toEqual([expect.stringMatching(/20%/)]);
  });
});

describe('executeSwap', () => {
  it('deposits once with purpose trade, executes, and completes', async () => {
    const { trade } = await quote();
    const done = await executeSwap({ trade });
    expect(done).toMatchObject({
      state: 'completed',
      depositTxHash: TX,
      destinationTxHash: '0xdest'
    });
    expect(fake.runTx).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ purpose: 'trade', ref: trade.intentId, chainId: 137 })
    );
    expect(fake.executeIntent).toHaveBeenCalledExactlyOnceWith({
      intentId: trade.intentId,
      depositTransactionHash: TX
    });
  });

  it('a succeeded receipt without the received amount completes without one (live: Trails sent null)', async () => {
    fake.waitIntentReceipt.mockResolvedValue({
      done: true,
      intentReceipt: {
        status: 'SUCCEEDED',
        destinationTransaction: { txnHash: '0xdest' },
        summary: { destinationTokenAmount: null }
      }
    });
    const { trade } = await quote();
    const done = await executeSwap({ trade });
    expect(done.state).toBe('completed');
    expect(done.receivedAmount).toBeUndefined();
    expect(() => describeTrade(done)).not.toThrow();
    // A record saved with "null" before the fix still describes.
    expect(() => describeTrade({ ...done, receivedAmount: 'null' })).not.toThrow();
  });

  it('an expired quote is refused without sending', async () => {
    const { trade } = await quote();
    const expired = { ...trade, expiresAt: new Date(Date.now() - 1000).toISOString() };
    saveTrade(expired);
    await expect(executeSwap({ trade: expired })).rejects.toMatchObject({
      code: 'quote_expired'
    });
    expect(fake.runTx).not.toHaveBeenCalled();
  });

  it('a check that fails before sending leaves the quote retryable', async () => {
    const { trade } = await quote();
    fake.runTx.mockRejectedValueOnce(
      Object.assign(new Error('limit'), { code: 'allowance_exhausted' })
    );
    await expect(executeSwap({ trade })).rejects.toThrow('limit');
    expect(loadTrade(trade.intentId)).toMatchObject({ state: 'quoted', error: 'limit' });
    expect(await executeSwap({ trade })).toMatchObject({ state: 'completed' });
    expect(fake.runTx).toHaveBeenCalledTimes(2);
  });

  it('a deposit whose result was lost is found in the transfer records, not resent', async () => {
    const { trade } = await quote();
    fake.runTx.mockImplementationOnce(async () => {
      // The transfer engine recorded it as executed, then the answer was lost.
      writeJsonFile({
        file: transferFile('t1'),
        data: {
          id: 't1',
          state: 'executed',
          chainId: 137,
          token: USDC,
          symbol: 'USDC',
          to: DEPOSIT,
          amount: '1000000',
          usd: 1,
          purpose: 'trade',
          ref: trade.intentId,
          walletId: 'w',
          sessionId: 's',
          txHash: TX,
          ledgered: true,
          createdAt: 'x',
          updatedAt: 'x'
        }
      });
      throw new Error('socket hang up');
    });
    const done = await executeSwap({ trade });
    expect(done).toMatchObject({ state: 'completed', depositTxHash: TX });
    expect(fake.runTx).toHaveBeenCalledTimes(1);
  });

  it('a trade interrupted while depositing is never resent while its transfer is unsettled', async () => {
    const { trade } = await quote();
    writeJsonFile({
      file: transferFile('t2'),
      data: {
        id: 't2',
        state: 'uncertain',
        chainId: 137,
        token: USDC,
        symbol: 'USDC',
        to: DEPOSIT,
        amount: '1000000',
        usd: 1,
        purpose: 'trade',
        ref: trade.intentId,
        walletId: 'w',
        sessionId: 's',
        txnId: 'txn',
        ledgered: false,
        createdAt: 'x',
        updatedAt: 'x'
      }
    });
    const interrupted = { ...trade, state: 'depositing' as const };
    saveTrade(interrupted);
    await expect(executeSwap({ trade: interrupted })).rejects.toMatchObject({
      code: 'upstream_unavailable'
    });
    expect(fake.runTx).not.toHaveBeenCalled();
  });

  it.each([
    ['abandoned by a replaced key', { state: 'abandoned' }],
    ['failed in a way that may have gone through', { state: 'failed', error: 'HTTP 409' }]
  ])('a transfer %s is never treated as unsent', async (_label, patch) => {
    const { trade } = await quote();
    fake.runTx.mockImplementationOnce(async () => {
      transferRecord({ id: 't3', ref: trade.intentId, patch });
      throw new Error('execute failed');
    });
    await expect(executeSwap({ trade })).rejects.toThrow('execute failed');
    expect(loadTrade(trade.intentId)?.state).toBe('depositing');
    await expect(executeSwap({ trade })).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(fake.runTx).toHaveBeenCalledTimes(1);
  });

  it('session_revoked after the transfer was recorded is not proof nothing was sent', async () => {
    const { trade } = await quote();
    const { CliError } = await import('../errors.ts');
    fake.runTx.mockImplementationOnce(async () => {
      // Executed, then polling the status hit a revoked key.
      transferRecord({ id: 't5', ref: trade.intentId, patch: { state: 'uncertain' } });
      throw new CliError({ code: 'session_revoked', message: 'revoked' });
    });
    await expect(executeSwap({ trade })).rejects.toThrow('revoked');
    expect(loadTrade(trade.intentId)?.state).toBe('depositing');
    await expect(executeSwap({ trade })).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(fake.runTx).toHaveBeenCalledTimes(1);
  });

  it('a transfer that certainly moved nothing reopens the quote', async () => {
    const { trade } = await quote();
    fake.runTx.mockImplementationOnce(async () => {
      transferRecord({ id: 't4', ref: trade.intentId, patch: { neverSent: true } });
      throw new Error('not sponsored');
    });
    await expect(executeSwap({ trade })).rejects.toThrow('not sponsored');
    expect(loadTrade(trade.intentId)?.state).toBe('quoted');
  });

  it('when OMS cannot settle the transfers, the outcome is unknown', async () => {
    const { trade } = await quote();
    fake.reconcileTransfers.mockRejectedValue(new Error('OMS down'));
    fake.runTx.mockRejectedValueOnce(new Error('timeout'));
    await expect(executeSwap({ trade })).rejects.toThrow('timeout');
    expect(loadTrade(trade.intentId)?.state).toBe('depositing');
  });

  it('refuses to send from a wallet that is no longer the one quoted for', async () => {
    const { trade } = await quote();
    fake.pointer = { ...fake.pointer, walletAddress: '0x1D17C0F90A0b3dFb5124C2FF56B33a0D2E202e1d' };
    await expect(executeSwap({ trade })).rejects.toMatchObject({ code: 'invalid_input' });
    fake.pointer = { ...fake.pointer, walletAddress: WALLET, access: undefined };
    await expect(executeSwap({ trade })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fake.runTx).not.toHaveBeenCalled();
  });

  it('with send: false (swap status) a quoted trade is never sent', async () => {
    const { trade } = await quote();
    expect(await executeSwap({ trade, send: false })).toMatchObject({ state: 'quoted' });
    expect(fake.runTx).not.toHaveBeenCalled();
  });

  it('a refusal raised before sending reopens the quote without waiting on OMS', async () => {
    const { trade } = await quote();
    const { CliError } = await import('../errors.ts');
    fake.runTx.mockRejectedValueOnce(new CliError({ code: 'wallet_busy', message: 'busy' }));
    await expect(executeSwap({ trade })).rejects.toThrow('busy');
    expect(loadTrade(trade.intentId)?.state).toBe('quoted');
    expect(fake.reconcileTransfers).not.toHaveBeenCalled();
  });

  it('passes the quote expiry so a deposit is never sent after it', async () => {
    const { trade } = await quote();
    await executeSwap({ trade });
    expect(fake.runTx).toHaveBeenCalledWith(
      expect.objectContaining({ notAfter: Date.parse(trade.expiresAt) })
    );
  });

  it('an interrupted trade that certainly sent nothing is sent on the next execute, once', async () => {
    const { trade } = await quote();
    const interrupted = { ...trade, state: 'depositing' as const };
    saveTrade(interrupted);
    expect(await executeSwap({ trade: interrupted, send: false })).toMatchObject({
      state: 'quoted'
    });
    expect(fake.runTx).not.toHaveBeenCalled();
    saveTrade(interrupted);
    expect(await executeSwap({ trade: interrupted })).toMatchObject({ state: 'completed' });
    expect(fake.runTx).toHaveBeenCalledTimes(1);
  });

  it('does not execute an intent Trails already has running', async () => {
    const { trade } = await quote();
    fake.getIntentReceipt.mockResolvedValue({ intentReceipt: { status: 'EXECUTING' } });
    const deposited = { ...trade, state: 'depositing' as const, depositTxHash: TX };
    saveTrade(deposited);
    await executeSwap({ trade: deposited });
    expect(fake.executeIntent).not.toHaveBeenCalled();
  });

  it('records a refund', async () => {
    const { trade } = await quote();
    fake.waitIntentReceipt.mockResolvedValue({
      done: true,
      intentReceipt: { status: 'REFUNDED', refundTransaction: { txnHash: '0xrefund' } }
    });
    expect(await executeSwap({ trade })).toMatchObject({
      state: 'refunded',
      refundTxHash: '0xrefund'
    });
  });

  it('returns executing at the timeout, and resumes later', async () => {
    const { trade } = await quote();
    fake.waitIntentReceipt.mockResolvedValueOnce({
      done: false,
      intentReceipt: { status: 'EXECUTING' }
    });
    const running = await executeSwap({ trade, timeoutMs: 0 });
    expect(running).toMatchObject({ state: 'executing', intentStatus: 'EXECUTING' });
    expect(await executeSwap({ trade: running })).toMatchObject({ state: 'completed' });
    expect(fake.runTx).toHaveBeenCalledTimes(1);
    expect(fake.executeIntent).toHaveBeenCalledTimes(1);
  });
});

import type * as Viem from 'viem';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Trails from '@0xtrails/api';

import { UnavailableError } from '@0xtrails/api';

import { swapCommand } from './operations.ts';

const mocks = vi.hoisted(() => ({
  quoteIntent: vi.fn(),
  executeIntent: vi.fn(),
  waitIntentReceipt: vi.fn(),
  getIntentReceipt: vi.fn(),
  runTx: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  createPublicClient: vi.fn()
}));

vi.mock('../lib/builder-provision.ts', () => ({
  ensureBuilderAccess: async () => undefined,
  ensureBuilderAccessKey: async () => ({ provisioned: false, reason: 'existing' }),
  makeDefaultProvisionDeps: () => ({})
}));
vi.mock('@0xtrails/api', async (importOriginal) => ({
  ...(await importOriginal<typeof Trails>()),
  TrailsApi: class {
    quoteIntent = mocks.quoteIntent;
    executeIntent = mocks.executeIntent;
    waitIntentReceipt = mocks.waitIntentReceipt;
    getIntentReceipt = mocks.getIntentReceipt;
  }
}));
vi.mock('viem', async (importOriginal) => ({
  ...(await importOriginal<typeof Viem>()),
  createPublicClient: mocks.createPublicClient
}));
vi.mock('../lib/storage.ts', async (importOriginal) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    ...(await importOriginal<object>()),
    // Saved trades go to a temp state folder.
    STORAGE_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'pa-swap-')),
    loadOmsWalletPointer: vi.fn(async () => ({ walletAddress: '0x1234' })),
    loadBuilderConfig: vi.fn(async () => ({ accessKey: 'test' }))
  };
});
vi.mock('../lib/oms-client.ts', () => ({ getOmsClient: vi.fn() }));
vi.mock('../lib/mode.ts', () => ({
  resolveBroadcast: (argv: { broadcast?: boolean }) => argv.broadcast === true,
  withWriteFlags: vi.fn()
}));
vi.mock('../lib/token-directory.ts', () => ({
  resolveErc20BySymbol: vi.fn(async () => ({ address: '0x5678', decimals: 6 }))
}));
vi.mock('../lib/tx-dispatch.ts', () => ({ runTx: mocks.runTx }));
vi.mock('../ui/render.js', () => ({ isTTY: vi.fn(), inkRender: vi.fn() }));
vi.mock('./operations-ui.js', () => ({ BalancesUI: vi.fn(), FundUI: vi.fn(), SendUI: vi.fn() }));

const txHash = `0x${'ab'.repeat(32)}`;
const intentId = 'test-intent';
const successReceipt = { status: 'success', transactionHash: txHash };
const depositAddress = '0x00000000000000000000000000000000000000d0';
const ONE = 10n ** 18n;

// A quote for 1 POL on Polygon → USDC on Base that passes deposit validation.
const quotedIntent = () => ({
  intentId,
  ownerAddress: '0x1234',
  originChainId: 137,
  destinationChainId: 8453,
  originTokenAddress: '0x0000000000000000000000000000000000000000',
  destinationTokenAddress: '0x5678',
  originIntentAddress: depositAddress,
  quoteRequest: {
    destinationToAddress: '0x1234',
    originTokenAmount: ONE,
    tradeType: 'EXACT_INPUT'
  },
  depositTransaction: { chainId: 137, to: depositAddress, value: ONE, data: '0x' },
  quote: { fromAmountUsd: 0.1, toAmount: 99_000n, toAmountMin: 98_600n, toAmountUsd: 0.099 },
  fees: { totalFeeUsd: 0.001 },
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
});

async function swap(overrides: Record<string, unknown> = {}) {
  if (typeof swapCommand.handler !== 'function') throw new Error('Missing swap handler');
  await swapCommand.handler({
    _: [],
    $0: 'polygon-agent',
    from: 'POL',
    to: 'USDC',
    amount: '1',
    chain: 'polygon',
    'to-chain': 'base',
    broadcast: true,
    ...overrides
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TRAILS_TOKEN_MAP_JSON', '');
  vi.stubEnv('SEQUENCE_PROJECT_ACCESS_KEY', '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('CLI exited');
  });
  mocks.createPublicClient.mockReturnValue({
    waitForTransactionReceipt: mocks.waitForTransactionReceipt
  });
  mocks.quoteIntent.mockResolvedValue({ intent: quotedIntent() });
  mocks.getIntentReceipt.mockRejectedValue(new Error('not found'));
  mocks.runTx.mockResolvedValue({ txHash });
  mocks.waitForTransactionReceipt.mockResolvedValue(successReceipt);
  mocks.executeIntent.mockResolvedValue({ intentStatus: 'EXECUTING' });
  mocks.waitIntentReceipt.mockResolvedValue({
    done: true,
    intentReceipt: { status: 'SUCCEEDED', summary: {} }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('swap deposit confirmation', () => {
  it('waits for the origin-chain receipt before executing a cross-chain intent', async () => {
    let confirm!: (receipt: typeof successReceipt) => void;
    mocks.waitForTransactionReceipt.mockReturnValue(
      new Promise((resolve) => {
        confirm = resolve;
      })
    );
    const pendingSwap = swap();
    await vi.waitFor(() => expect(mocks.waitForTransactionReceipt).toHaveBeenCalled());
    expect(mocks.executeIntent).not.toHaveBeenCalled();
    expect(mocks.createPublicClient).toHaveBeenCalledWith(
      expect.objectContaining({
        chain: expect.objectContaining({ id: 137 })
      })
    );
    expect(mocks.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: txHash, timeout: 60_000 });
    confirm(successReceipt);
    await pendingSwap;
    expect(mocks.executeIntent).toHaveBeenCalledExactlyOnceWith({
      intentId,
      depositTransactionHash: txHash
    });
    expect(mocks.runTx).toHaveBeenCalledTimes(1);
  });

  it.each(['timeout', 'RPC unavailable'])(
    'does not execute or resend after receipt failure: %s',
    async (reason) => {
      mocks.waitForTransactionReceipt.mockRejectedValue(new Error(reason));
      await expect(swap()).rejects.toThrow('CLI exited');
      expect(mocks.executeIntent).not.toHaveBeenCalled();
      expect(mocks.runTx).toHaveBeenCalledTimes(1);
      const output = JSON.parse(vi.mocked(console.error).mock.calls[0][0] as string);
      expect(output.error).toContain(intentId);
      expect(output.error).toContain(txHash);
      expect(output.error).toContain(reason);
    }
  );

  it.each([
    { ...successReceipt, status: 'reverted' },
    { ...successReceipt, transactionHash: `0x${'cd'.repeat(32)}` }
  ])('does not execute a reverted or replaced deposit: %j', async (receipt) => {
    mocks.waitForTransactionReceipt.mockResolvedValue(receipt);
    await expect(swap()).rejects.toThrow('CLI exited');
    expect(mocks.executeIntent).not.toHaveBeenCalled();
  });

  it('retries transient execution errors after confirmation without sending another deposit', async () => {
    vi.useFakeTimers();
    mocks.executeIntent.mockRejectedValueOnce(new UnavailableError());
    const pendingSwap = swap();
    await vi.waitFor(() => expect(mocks.executeIntent).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(3000);
    await pendingSwap;
    expect(mocks.executeIntent).toHaveBeenCalledTimes(2);
    expect(mocks.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(mocks.runTx).toHaveBeenCalledTimes(1);
  });

  it('a dry run saves the quote, and --intent executes exactly it without quoting again', async () => {
    await swap({ broadcast: false });
    const dryRun = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)?.[0] as string);
    expect(dryRun).toMatchObject({
      dryRun: true,
      intentId,
      command: `polygon-agent swap --intent ${intentId} --broadcast`
    });
    await swap({ intent: intentId, from: undefined, to: undefined, amount: undefined });
    expect(mocks.quoteIntent).toHaveBeenCalledTimes(1);
    expect(mocks.runTx).toHaveBeenCalledTimes(1);
    const done = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)?.[0] as string);
    expect(done).toMatchObject({ ok: true, intentId, state: 'completed', depositTxHash: txHash });
  });

  it('swap status resumes a trade still executing, without sending anything', async () => {
    mocks.waitIntentReceipt.mockResolvedValueOnce({
      done: false,
      intentReceipt: { status: 'EXECUTING' }
    });
    await swap({ timeout: 0 });
    expect(JSON.parse(vi.mocked(console.log).mock.calls.at(-1)?.[0] as string)).toMatchObject({
      state: 'executing',
      command: `polygon-agent swap status --intent ${intentId}`
    });
    await swap({ action: 'status', intent: intentId });
    expect(JSON.parse(vi.mocked(console.log).mock.calls.at(-1)?.[0] as string)).toMatchObject({
      state: 'completed'
    });
    expect(mocks.runTx).toHaveBeenCalledTimes(1);
    expect(mocks.executeIntent).toHaveBeenCalledTimes(1);
  });

  it('only quotes on a dry run', async () => {
    await swap({ broadcast: false });
    expect(mocks.quoteIntent).toHaveBeenCalledTimes(1);
    expect(mocks.runTx).not.toHaveBeenCalled();
    expect(mocks.waitForTransactionReceipt).not.toHaveBeenCalled();
    expect(mocks.executeIntent).not.toHaveBeenCalled();
  });
});

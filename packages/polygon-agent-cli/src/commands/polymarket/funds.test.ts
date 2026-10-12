import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-pm-funds-'));

const m = vi.hoisted(() => ({
  runTx: vi.fn(),
  checkSessionSpend: vi.fn(),
  tokenBalance: vi.fn(),
  pusdBalance: vi.fn(),
  transferErc20: vi.fn(),
  depositAddress: vi.fn(async () => '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1'),
  withdrawAddress: vi.fn(async () => '0xB2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2'),
  bridgeStatus: vi.fn(
    async (): Promise<{ transactions: Array<{ status: string }> }> => ({ transactions: [] })
  )
}));

vi.mock('../../lib/tx-dispatch.ts', () => ({ runTx: m.runTx }));
vi.mock('../../lib/session/run-tx.ts', () => ({ checkSessionSpend: m.checkSessionSpend }));
vi.mock('../../lib/session/live.ts', () => ({ tokenBalance: m.tokenBalance }));
vi.mock('../../lib/polymarket/region.ts', async (o) => ({
  ...(await o<Record<string, unknown>>()),
  checkRegion: async () => ({ blocked: false, closeOnly: false, country: 'PT', region: null })
}));
vi.mock('../../lib/polymarket/bridge.ts', async (o) => ({
  ...(await o<Record<string, unknown>>()),
  depositAddress: m.depositAddress,
  withdrawAddress: m.withdrawAddress,
  bridgeStatus: m.bridgeStatus
}));
vi.mock('../../lib/polymarket/account.ts', async (o) => ({
  ...(await o<Record<string, unknown>>()),
  requireAccount: (w: string) => {
    if (w !== 'main') throw Object.assign(new Error('no'), { code: 'not_set_up' });
    return {
      kind: 'deposit-wallet',
      signer: '0x1',
      wallet: '0xD0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0',
      createdAt: 'x'
    };
  },
  pusdBalance: m.pusdBalance,
  getTradingClient: async () => ({ transferErc20: m.transferErc20 })
}));

const { depositCommand, withdrawCommand } = await import('./funds.ts');
const { CliError } = await import('../../lib/errors.ts');
const { saveOmsWalletPointer } = await import('../../lib/storage.ts');
const { savePending, loadPending, clearPending } = await import('../../lib/polymarket/deposits.ts');

const pend = (over: Record<string, unknown> = {}) => ({
  status: 'sent' as const,
  txHash: '0xOLD' as string | null,
  amountUnits: '5000000',
  bridgeAddress: '0xB1',
  sentAt: 'x',
  baselineCount: 0,
  pusdBefore: '0',
  ...over
});

async function run(argv: string[]) {
  const yargs = (await import('yargs')).default;
  await yargs()
    .command(depositCommand)
    .command(withdrawCommand)
    .fail(false)
    .parseAsync(argv)
    .catch(() => undefined);
  const lines = [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls]
    .map((c) => String(c[0]))
    .filter((l) => l.trimStart().startsWith('{'));
  return JSON.parse(lines.at(-1) ?? '{}');
}

beforeEach(async () => {
  await saveOmsWalletPointer('main', {
    walletAddress: '0xC2F4cAfe89AE7e1bcB86dd3f141C0a3adCEB6C17',
    loginMethod: 'google',
    createdAt: 'x'
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  m.tokenBalance.mockResolvedValue(50_000_000n);
  m.runTx.mockResolvedValue({ walletAddress: '0xC2F4', txHash: '0xTX' });
  m.pusdBalance.mockResolvedValue(0n);
  clearPending('main');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('deposit', () => {
  it('rejects amounts under the bridge minimum before any network call', async () => {
    const out = await run(['deposit', '1.5', '--dry-run']);
    expect(out).toMatchObject({ ok: false, code: 'below_bridge_minimum' });
    expect(m.depositAddress).not.toHaveBeenCalled();
  });

  it('rejects malformed amounts with invalid_input', async () => {
    expect(await run(['deposit', '2.0000001', '--dry-run'])).toMatchObject({
      code: 'invalid_input'
    });
  });

  it('sends one plain USDC transfer to the bridge address through runTx', async () => {
    m.pusdBalance.mockResolvedValueOnce(0n).mockResolvedValue(5_000_000n);
    const out = await run(['deposit', '5', '--broadcast']);
    expect(m.runTx).toHaveBeenCalledTimes(1);
    const p = m.runTx.mock.calls[0][0];
    expect(p).toMatchObject({
      walletName: 'main',
      chainId: 137,
      broadcast: true,
      purpose: 'trade',
      ref: 'polymarket-deposit'
    });
    expect(p.transactions).toHaveLength(1);
    expect(p.transactions[0].to).toBe('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359');
    expect(p.transactions[0].data.startsWith('0xa9059cbb')).toBe(true);
    expect(p.transactions[0].data.toLowerCase()).toContain(
      'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1'
    );
    expect(out).toMatchObject({ ok: true, txHash: '0xTX', credited: true });
    expect(loadPending('main')).toBeNull();
  }, 20_000);

  it('does not send again while an earlier deposit is still pending', async () => {
    savePending('main', pend());
    const out = await run(['deposit', '5', '--broadcast']);
    expect(out).toMatchObject({ ok: false, code: 'bridge_pending', txHash: '0xOLD' });
    expect(m.runTx).not.toHaveBeenCalled();
  });

  it('sends again with --again', async () => {
    savePending('main', pend());
    await run(['deposit', '5', '--broadcast', '--again', '--no-wait']);
    expect(m.runTx).toHaveBeenCalledTimes(1);
  });

  it('reports upstream_error and clears the record when a NEW entry FAILED', async () => {
    savePending('main', pend());
    m.bridgeStatus.mockResolvedValueOnce({ transactions: [{ status: 'FAILED' }] });
    const out = await run(['deposit', '5', '--broadcast']);
    expect(out).toMatchObject({ ok: false, code: 'upstream_error' });
    expect(String(out.hint)).toMatch(/recovery\.polymarket\.com/);
    expect(out).toMatchObject({ txHash: '0xOLD', bridgeStatus: 'FAILED' });
    expect(loadPending('main')).toBeNull();
    expect(m.runTx).not.toHaveBeenCalled();
  });

  it('proceeds when a NEW entry COMPLETED', async () => {
    savePending('main', pend({ baselineCount: 1 }));
    m.bridgeStatus.mockResolvedValueOnce({
      transactions: [{ status: 'COMPLETED' }, { status: 'COMPLETED' }]
    });
    await run(['deposit', '5', '--broadcast', '--no-wait']);
    expect(m.runTx).toHaveBeenCalledTimes(1);
  });

  it('proceeds when pUSD already rose by the deposit amount', async () => {
    savePending('main', pend({ pusdBefore: '1000000' }));
    m.pusdBalance.mockResolvedValue(6_000_000n);
    await run(['deposit', '5', '--broadcast', '--no-wait']);
    expect(m.runTx).toHaveBeenCalledTimes(1);
  });

  it('an older COMPLETED entry beyond the baseline does not settle a pending deposit', async () => {
    savePending('main', pend({ baselineCount: 1 }));
    m.bridgeStatus.mockResolvedValueOnce({ transactions: [{ status: 'COMPLETED' }] });
    const out = await run(['deposit', '5', '--broadcast']);
    expect(out).toMatchObject({ ok: false, code: 'bridge_pending', txHash: '0xOLD' });
    expect(m.runTx).not.toHaveBeenCalled();
    expect(loadPending('main')).not.toBeNull();
  });

  it('an older FAILED entry beyond the baseline is bridge_pending, not upstream_error', async () => {
    savePending('main', pend({ baselineCount: 1 }));
    m.bridgeStatus.mockResolvedValueOnce({ transactions: [{ status: 'FAILED' }] });
    const out = await run(['deposit', '5', '--broadcast']);
    expect(out).toMatchObject({ ok: false, code: 'bridge_pending' });
    expect(m.runTx).not.toHaveBeenCalled();
    expect(loadPending('main')).not.toBeNull();
  });

  it('a dry run never changes the pending record', async () => {
    savePending('main', pend());
    m.bridgeStatus.mockResolvedValueOnce({ transactions: [{ status: 'COMPLETED' }] });
    const settled = await run(['deposit', '5', '--dry-run']);
    expect(settled).toMatchObject({ ok: true, dryRun: true });
    expect(loadPending('main')).not.toBeNull();
    m.bridgeStatus.mockResolvedValueOnce({ transactions: [{ status: 'FAILED' }] });
    const failed = await run(['deposit', '5', '--dry-run']);
    expect(failed).toMatchObject({ ok: false, code: 'upstream_error' });
    expect(loadPending('main')).not.toBeNull();
  });

  it('keeps no record when runTx refuses before sending anything', async () => {
    m.runTx.mockRejectedValue(new CliError({ code: 'insufficient_balance', message: 'no' }));
    const out = await run(['deposit', '5', '--broadcast']);
    expect(out).toMatchObject({ ok: false, code: 'insufficient_balance' });
    expect(loadPending('main')).toBeNull();
  });

  it('keeps no record when the OMS wallet cannot pay the relayer fee', async () => {
    const { makeFeeSelector } = await import('../../lib/oms-tx.ts');
    let refusal: unknown;
    try {
      makeFeeSelector(false)([
        {
          feeOption: {
            token: { network: '137', name: 'USDC', symbol: 'USDC', type: 'erc20' },
            value: '5',
            displayValue: '5'
          },
          selection: { token: 'USDC', index: 0 },
          availableRaw: '0'
        } as never
      ]);
    } catch (e) {
      refusal = e;
    }
    m.runTx.mockRejectedValue(refusal);
    const out = await run(['deposit', '5', '--broadcast']);
    expect(out).toMatchObject({ ok: false, code: 'insufficient_balance' });
    expect(String(out.error)).toMatch(/Unable to pay gas/);
    expect(loadPending('main')).toBeNull();
  });

  it('fails with wallet_busy, sending nothing, while another deposit holds the lock', async () => {
    const { withLock } = await import('../../lib/lock.ts');
    const { STORAGE_ROOT } = await import('../../lib/storage.ts');
    const out = await withLock({
      dir: path.join(STORAGE_ROOT, 'locks', 'polymarket', 'main'),
      fn: () => run(['deposit', '5', '--broadcast', '--no-wait'])
    });
    expect(out).toMatchObject({ ok: false, code: 'wallet_busy' });
    expect(m.runTx).not.toHaveBeenCalled();
    expect(loadPending('main')).toBeNull();
  });

  it('a dry run does not need the deposit lock', async () => {
    const { withLock } = await import('../../lib/lock.ts');
    const { STORAGE_ROOT } = await import('../../lib/storage.ts');
    const out = await withLock({
      dir: path.join(STORAGE_ROOT, 'locks', 'polymarket', 'main'),
      fn: () => run(['deposit', '5', '--dry-run'])
    });
    expect(out).toMatchObject({ ok: true, dryRun: true });
  });

  it('keeps a sending record when runTx fails after the transfer may have gone out', async () => {
    m.runTx.mockRejectedValue(new Error('timed out waiting for status'));
    const first = await run(['deposit', '5', '--broadcast']);
    expect(first).toMatchObject({ ok: false });
    expect(loadPending('main')).toMatchObject({ status: 'sending', txHash: null });
    m.runTx.mockClear();
    const second = await run(['deposit', '5', '--broadcast']);
    expect(second).toMatchObject({ ok: false, code: 'bridge_pending' });
    expect(m.runTx).not.toHaveBeenCalled();
  });

  it('a failing balance read while polling ends credited:false with the txHash', async () => {
    m.pusdBalance.mockResolvedValueOnce(0n).mockRejectedValue(new Error('rpc down'));
    const realNow = Date.now();
    const now = vi.spyOn(Date, 'now');
    now
      .mockReturnValueOnce(realNow)
      .mockReturnValueOnce(realNow)
      .mockReturnValue(realNow + 600_000);
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0;
    }) as never);
    const out = await run(['deposit', '5', '--broadcast']);
    expect(out).toMatchObject({ ok: true, credited: false, txHash: '0xTX' });
    expect(loadPending('main')).toMatchObject({ status: 'sent', txHash: '0xTX' });
  });

  it('never stores an empty hash when runTx returns none', async () => {
    m.runTx.mockResolvedValue({ walletAddress: '0xC2F4' });
    const out = await run(['deposit', '5', '--broadcast', '--no-wait']);
    expect(out).toMatchObject({ ok: true, txHash: null, credited: false });
    expect(loadPending('main')).toMatchObject({ status: 'sent', txHash: null });
  });

  it('dry run prints one summary and never calls runTx', async () => {
    const out = await run(['deposit', '5', '--dry-run']);
    expect(m.runTx).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      ok: true,
      dryRun: true,
      from: '0xC2F4cAfe89AE7e1bcB86dd3f141C0a3adCEB6C17',
      bridgeAddress: '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1',
      polymarketWallet: '0xD0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0',
      amountUsd: '5'
    });
    expect(out.allowance).toBeUndefined();
    expect(m.checkSessionSpend).not.toHaveBeenCalled();
    const jsonDocs = vi
      .mocked(console.log)
      .mock.calls.filter((c) => String(c[0]).trimStart().startsWith('{'));
    expect(jsonDocs).toHaveLength(1);
  });

  it('session-mode dry run includes the allowance check', async () => {
    await saveOmsWalletPointer('main', {
      walletAddress: '0xC2F4cAfe89AE7e1bcB86dd3f141C0a3adCEB6C17',
      loginMethod: 'google',
      createdAt: 'x',
      access: 'session'
    });
    m.checkSessionSpend.mockResolvedValue({
      usd: 5,
      allowanceUsd: 100,
      spentUsd: 20,
      symbol: 'USDC',
      decimals: 6,
      remaining: 80_000_000n
    });
    const out = await run(['deposit', '5', '--dry-run']);
    expect(m.runTx).not.toHaveBeenCalled();
    expect(m.checkSessionSpend).toHaveBeenCalledWith(
      expect.objectContaining({
        walletName: 'main',
        chainId: 137,
        token: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
        amount: 5_000_000n
      })
    );
    expect(out).toMatchObject({
      ok: true,
      dryRun: true,
      allowance: { usd: 5, allowanceUsd: 100, spentUsd: 20 }
    });
  });

  it('points at a swap when the OMS wallet lacks USDC', async () => {
    m.tokenBalance.mockResolvedValue(1_000_000n);
    const out = await run(['deposit', '5', '--dry-run']);
    expect(out).toMatchObject({ ok: false, code: 'insufficient_balance' });
    expect(String(out.hint)).toMatch(/agent swap/);
  });
});

describe('withdraw', () => {
  it('withdraws everything to a bridge address paying the OMS wallet', async () => {
    m.pusdBalance.mockResolvedValue(3_250_000n);
    m.transferErc20.mockResolvedValue({ wait: async () => ({ transactionHash: '0xW' }) });
    const out = await run(['withdraw', 'all', '--broadcast']);
    expect(m.withdrawAddress).toHaveBeenCalledWith({
      wallet: '0xD0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0',
      recipient: '0xC2F4cAfe89AE7e1bcB86dd3f141C0a3adCEB6C17'
    });
    expect(m.transferErc20).toHaveBeenCalledWith({
      amount: 3_250_000n,
      recipientAddress: '0xB2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2',
      tokenAddress: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'
    });
    expect(out).toMatchObject({ ok: true, txHash: '0xW', amountUsd: '3.25' });
    expect(String(out.note)).toMatch(/pUSD transfer to Polymarket's bridge.*OMS wallet/);
  });

  it('refuses more than the pUSD balance', async () => {
    m.pusdBalance.mockResolvedValue(1_000_000n);
    expect(await run(['withdraw', '2', '--dry-run'])).toMatchObject({
      ok: false,
      code: 'insufficient_pusd'
    });
  });

  it('refuses an empty balance for all', async () => {
    m.pusdBalance.mockResolvedValue(0n);
    expect(await run(['withdraw', 'all', '--dry-run'])).toMatchObject({
      ok: false,
      code: 'insufficient_pusd'
    });
  });
});

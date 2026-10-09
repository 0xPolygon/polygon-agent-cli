import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-pm-account-'));

const WALLET = '0xD0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0';
const COND = '0x' + 'ab'.repeat(32);

const m = vi.hoisted(() => ({
  account: null as null | Record<string, unknown>,
  planSetup: vi.fn(),
  setupAccount: vi.fn(),
  pusdBalance: vi.fn(),
  legacyApproved: vi.fn(),
  redeemPositions: vi.fn(),
  listPositions: vi.fn(),
  getPositions: vi.fn(),
  loadPolymarketKey: vi.fn(),
  importLegacyKey: vi.fn(),
  ensureTradingKey: vi.fn(),
  backupTradingKey: vi.fn(),
  ensureMainWallet: vi.fn(),
  findTradingKeyWallet: vi.fn(),
  restoreFromOms: vi.fn(),
  localKey: false,
  omsWallet: { walletAddress: '0xC2F4cAfe89AE7e1bcB86dd3f141C0a3adCEB6C17' as string | undefined }
}));

// A Paginated stand-in: an async iterable of pages.
const pages = (...items: unknown[][]) => ({
  async *[Symbol.asyncIterator]() {
    for (const [i, p] of items.entries())
      yield {
        items: p,
        hasMore: i < items.length - 1,
        nextCursor: i < items.length - 1 ? `c${i}` : undefined
      };
  }
});

const client = {
  fetchTradingApprovalsState: async () => ({ isFullyApproved: true }),
  listOpenOrders: () => ({ firstPage: async () => ({ items: [{}, {}] }) }),
  listPositions: m.listPositions,
  redeemPositions: m.redeemPositions,
  listActivity: () => ({
    firstPage: async () => ({
      items: [{ type: 'TRADE', timestamp: 0, title: 'T', side: 'BUY', transactionHash: '0xh' }],
      nextCursor: 'n1'
    })
  }),
  fetchUserPnl: async () => ({
    points: [
      { timestamp: 1, realizedPnl: '1', unrealizedPnl: '2' },
      { timestamp: 2, realizedPnl: '3', unrealizedPnl: '4' }
    ]
  }),
  fetchPortfolioValue: async () => ({ wallet: WALLET, value: '9.5' })
};

vi.mock('../../lib/polymarket/region.ts', async (o) => ({
  ...(await o<Record<string, unknown>>()),
  checkRegion: async () => ({ blocked: false, closeOnly: false, country: 'PT', region: null })
}));
vi.mock('../../lib/polymarket/account.ts', async (o) => {
  const { CliError } = await import('../../lib/errors.ts');
  return {
    ...(await o<Record<string, unknown>>()),
    planSetup: m.planSetup,
    setupAccount: m.setupAccount,
    loadAccount: () => m.account,
    requireAccount: () => {
      if (!m.account) throw new CliError({ code: 'not_set_up', message: 'no account' });
      return m.account;
    },
    pusdBalance: m.pusdBalance,
    legacyNegRiskApproved: m.legacyApproved,
    importLegacyKey: m.importLegacyKey,
    ensureTradingKey: m.ensureTradingKey,
    hasLocalKey: () => m.localKey,
    restoreFromOms: m.restoreFromOms,
    getTradingClient: async () => client
  };
});
vi.mock('../../lib/polymarket/oms-key.ts', async (o) => ({
  ...(await o<Record<string, unknown>>()),
  backupTradingKey: m.backupTradingKey,
  findTradingKeyWallet: m.findTradingKeyWallet
}));
vi.mock('../../lib/oms-client.ts', async (o) => ({
  ...(await o<Record<string, unknown>>()),
  getOmsClient: () => ({ wallet: m.omsWallet })
}));
vi.mock('../../lib/oms-tx.ts', async (o) => ({
  ...(await o<Record<string, unknown>>()),
  ensureMainWallet: m.ensureMainWallet
}));
vi.mock('../../lib/polymarket/gamma.ts', async (o) => ({
  ...(await o<Record<string, unknown>>()),
  getPositions: m.getPositions,
  getPolymarketProxyWalletAddress: async () => '0xLEGACYPROXY'
}));
vi.mock('../../lib/storage.ts', async (o) => ({
  ...(await o<Record<string, unknown>>()),
  loadPolymarketKey: m.loadPolymarketKey
}));

const cmds = await import('./account.ts');
const portfolio = await import('./portfolio.ts');
const { saveOmsWalletPointer } = await import('../../lib/storage.ts');
const { accountFile, readBackup, writeBackup } = await import('../../lib/polymarket/account.ts');
const TRADING_KEY = `0x${'11'.repeat(32)}`;
const BACKUP = { omsWalletId: 'w-imported', address: '0xAbC', at: '2026-10-09T00:00:00.000Z' };

async function run(argv: string[]) {
  const yargs = (await import('yargs')).default;
  await yargs()
    .command(cmds.setupCommand)
    .command(cmds.statusCommand)
    .command(cmds.importKeyCommand)
    .command(portfolio.positionsCommand)
    .command(portfolio.redeemCommand)
    .command(portfolio.activityCommand)
    .command(portfolio.pnlCommand)
    .fail(false)
    .parseAsync(argv)
    .catch(() => undefined);
  const lines = [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls]
    .map((c) => String(c[0]))
    .filter((l) => l.trimStart().startsWith('{'));
  return JSON.parse(lines.at(-1) ?? '{}');
}

const ACCOUNT = { kind: 'deposit-wallet', signer: '0x1', wallet: WALLET, createdAt: 'x' };

beforeEach(async () => {
  await saveOmsWalletPointer('main', {
    walletAddress: '0xC2F4cAfe89AE7e1bcB86dd3f141C0a3adCEB6C17',
    loginMethod: 'google',
    createdAt: 'x'
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  m.account = null;
  m.localKey = false;
  m.findTradingKeyWallet.mockResolvedValue(null);
  fs.rmSync(path.join(String(process.env.POLYGON_AGENT_HOME), 'polymarket'), {
    recursive: true,
    force: true
  });
  m.omsWallet.walletAddress = '0xC2F4cAfe89AE7e1bcB86dd3f141C0a3adCEB6C17';
  m.ensureTradingKey.mockResolvedValue(TRADING_KEY);
  m.backupTradingKey.mockResolvedValue({
    omsWalletId: 'w-imported',
    address: '0xAbC',
    imported: true
  });
  m.planSetup.mockImplementation(() => ({ exists: !!m.account, account: m.account }));
  m.setupAccount.mockResolvedValue({ account: ACCOUNT, created: true, approvalsSet: true });
  m.pusdBalance.mockResolvedValue(2_500_000n);
  m.legacyApproved.mockResolvedValue(true);
  m.loadPolymarketKey.mockRejectedValue(new Error('none'));
  m.getPositions.mockResolvedValue({ positions: [{ a: 1 }], nextCursor: 'p2' });
  m.listPositions.mockReturnValue(pages([{ conditionId: COND, title: 'Q', currentValue: '1.2' }]));
  m.redeemPositions.mockResolvedValue({ wait: async () => ({ transactionHash: '0xTX' }) });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('setup', () => {
  it('dry run lists four steps and does not set up', async () => {
    const out = await run(['setup', '--dry-run']);
    expect(out).toMatchObject({ ok: true, dryRun: true, exists: false });
    expect(out.steps).toHaveLength(6);
    expect(out.steps.at(-1)).toBe('back up the trading key to OMS');
    expect(m.setupAccount).not.toHaveBeenCalled();
  });

  it('dry run drops finished steps when the account exists', async () => {
    m.account = ACCOUNT;
    const out = await run(['setup', '--dry-run']);
    expect(out).toMatchObject({ exists: true, account: ACCOUNT });
    expect(out.steps).toEqual([
      'set trading approvals (gasless)',
      'back up the trading key to OMS'
    ]);
    writeBackup('main', BACKUP);
    expect((await run(['setup', '--dry-run'])).steps).toEqual(['set trading approvals (gasless)']);
  });

  it('dry run for an existing account lists the legacy step only when it is missing', async () => {
    m.account = ACCOUNT;
    m.legacyApproved.mockResolvedValue(false);
    writeBackup('main', BACKUP);
    const out = await run(['setup', '--dry-run']);
    expect(out.steps).toEqual([
      'set trading approvals (gasless)',
      'approve the legacy NegRiskAdapter for neg-risk markets (gasless)'
    ]);
  });

  it('broadcast sets up once', async () => {
    const out = await run(['setup', '--broadcast']);
    expect(m.setupAccount).toHaveBeenCalledTimes(1);
    expect(m.setupAccount).toHaveBeenCalledWith('main');
    expect(out).toMatchObject({
      ok: true,
      created: true,
      approvalsSet: true,
      account: { kind: 'deposit-wallet', wallet: WALLET },
      next: 'agent polymarket deposit <usd> --broadcast'
    });
  });

  it('owner mode backs up once, writes backup.json and restores the main wallet', async () => {
    const out = await run(['setup', '--broadcast']);
    expect(m.backupTradingKey).toHaveBeenCalledTimes(1);
    expect(m.backupTradingKey).toHaveBeenCalledWith(m.omsWallet, TRADING_KEY);
    expect(out.backup).toEqual({ omsWalletId: 'w-imported', imported: true });
    expect(readBackup('main')).toMatchObject({ omsWalletId: 'w-imported', address: '0xAbC' });
    expect(m.ensureMainWallet).toHaveBeenCalledWith('main');
    expect(fs.readFileSync(accountFile('main', 'backup.json'), 'utf8')).not.toContain(TRADING_KEY);
    expect(JSON.stringify(out)).not.toContain(TRADING_KEY);
  });

  it('a rerun makes no import', async () => {
    await run(['setup', '--broadcast']);
    m.backupTradingKey.mockResolvedValue({
      omsWalletId: 'w-imported',
      address: '0xAbC',
      imported: false
    });
    const out = await run(['setup', '--broadcast']);
    expect(out.backup).toEqual({ omsWalletId: 'w-imported', imported: false });
    expect(readBackup('main')?.omsWalletId).toBe('w-imported');
  });

  it('a failed backup does not fail setup and says how to retry', async () => {
    m.backupTradingKey.mockRejectedValue(new Error('oms down'));
    const out = await run(['setup', '--broadcast']);
    expect(out).toMatchObject({
      ok: true,
      created: true,
      backup: {
        backedUp: false,
        error: 'oms down',
        hint: 'Run polymarket setup --broadcast again to retry the backup.'
      }
    });
    expect(readBackup('main')).toBeNull();
    expect(m.ensureMainWallet).toHaveBeenCalledWith('main');
  });

  it('a failing main-wallet restore does not mask the backup error', async () => {
    m.backupTradingKey.mockRejectedValue(new Error('oms down'));
    m.ensureMainWallet.mockRejectedValue(new Error('no main wallet'));
    const out = await run(['setup', '--broadcast']);
    expect(out.ok).toBe(true);
    expect(out.backup).toMatchObject({
      backedUp: false,
      error: 'oms down',
      mainWalletError: 'no main wallet'
    });
  });

  it('a failing main-wallet restore after a good backup is reported alongside it', async () => {
    m.ensureMainWallet.mockRejectedValue(new Error('no main wallet'));
    const out = await run(['setup', '--broadcast']);
    expect(out.backup).toEqual({
      omsWalletId: 'w-imported',
      imported: true,
      mainWalletError: 'no main wallet'
    });
  });

  it('still succeeds without a live owner session', async () => {
    m.localKey = true;
    m.omsWallet.walletAddress = undefined;
    const out = await run(['setup', '--broadcast']);
    expect(out).toMatchObject({
      ok: true,
      created: true,
      backup: { backedUp: false, hint: 'agent wallet login' }
    });
    expect(m.backupTradingKey).not.toHaveBeenCalled();
    expect(readBackup('main')).toBeNull();
  });

  it('owner mode without a local key refuses while signed out: OMS may hold the key', async () => {
    m.omsWallet.walletAddress = undefined;
    const out = await run(['setup', '--broadcast']);
    expect(out).toMatchObject({ ok: false, code: 'not_set_up' });
    expect(m.setupAccount).not.toHaveBeenCalled();
    expect(m.ensureTradingKey).not.toHaveBeenCalled();
  });

  it('owner mode on a wiped machine restores the account OMS holds instead of making a key', async () => {
    const found = { id: 'w-old', address: '0x00000000000000000000000000000000000000A1' };
    m.findTradingKeyWallet.mockResolvedValue(found);
    m.restoreFromOms.mockResolvedValue({
      account: { kind: 'deposit-wallet', signer: found.address, wallet: WALLET, createdAt: 'x' },
      approvalsSet: true,
      backup: { omsWalletId: 'w-old', address: found.address, at: 'x', kind: 'deposit-wallet' }
    });
    const out = await run(['setup', '--broadcast']);
    expect(m.findTradingKeyWallet).toHaveBeenCalledWith(m.omsWallet, undefined);
    expect(m.restoreFromOms).toHaveBeenCalledWith({
      wallet: 'main',
      owner: m.omsWallet,
      target: found
    });
    expect(out).toMatchObject({
      ok: true,
      created: false,
      restored: true,
      signer: 'oms',
      approvalsSet: true,
      account: { wallet: WALLET, signer: found.address },
      backup: { backedUp: true, omsWalletId: 'w-old' }
    });
    expect(m.setupAccount).not.toHaveBeenCalled();
    expect(m.ensureTradingKey).not.toHaveBeenCalled();
    expect(m.backupTradingKey).not.toHaveBeenCalled();
    expect(m.ensureMainWallet).toHaveBeenCalledWith('main');
  });

  it('owner mode with account.json but no key looks up the recorded signer and restores', async () => {
    m.account = { ...ACCOUNT, signer: '0x00000000000000000000000000000000000000A2' };
    const found = { id: 'w-old', address: '0x00000000000000000000000000000000000000A2' };
    m.findTradingKeyWallet.mockResolvedValue(found);
    m.restoreFromOms.mockResolvedValue({
      account: m.account,
      approvalsSet: false,
      backup: { omsWalletId: 'w-old', address: found.address, at: 'x' }
    });
    const out = await run(['setup', '--broadcast']);
    expect(m.findTradingKeyWallet).toHaveBeenCalledWith(m.omsWallet, found.address);
    expect(out).toMatchObject({ ok: true, restored: true, signer: 'oms' });
    expect(m.setupAccount).not.toHaveBeenCalled();
  });

  it('owner mode creates as before when OMS holds no trading key', async () => {
    const out = await run(['setup', '--broadcast']);
    expect(m.findTradingKeyWallet).toHaveBeenCalledTimes(1);
    expect(m.restoreFromOms).not.toHaveBeenCalled();
    expect(m.setupAccount).toHaveBeenCalledWith('main');
    expect(out).toMatchObject({ ok: true, created: true });
  });

  it('a failed restore fails setup without making a key, and still restores the main wallet', async () => {
    m.findTradingKeyWallet.mockResolvedValue({ id: 'w-old', address: '0xA1' });
    m.restoreFromOms.mockRejectedValue(new Error('relayer down'));
    const out = await run(['setup', '--broadcast']);
    expect(JSON.stringify(out)).toMatch(/relayer down/);
    expect(out.ok).toBe(false);
    expect(m.setupAccount).not.toHaveBeenCalled();
    expect(m.ensureMainWallet).toHaveBeenCalledWith('main');
  });

  it('session mode does not try OMS and reports the recorded backup', async () => {
    await saveOmsWalletPointer('main', {
      walletAddress: '0xC2F4cAfe89AE7e1bcB86dd3f141C0a3adCEB6C17',
      loginMethod: 'google',
      createdAt: 'x',
      access: 'session'
    } as never);
    writeBackup('main', BACKUP);
    const out = await run(['setup', '--broadcast']);
    expect(m.backupTradingKey).not.toHaveBeenCalled();
    expect(out.backup).toEqual({ backedUp: true, omsWalletId: 'w-imported' });
  });
});

describe('status', () => {
  it('reports not set up without an account', async () => {
    expect(await run(['status'])).toEqual({
      ok: true,
      setUp: false,
      next: 'agent polymarket setup --broadcast'
    });
  });

  it('summarizes balance, approvals, orders and redeemable positions', async () => {
    m.account = ACCOUNT;
    const out = await run(['status']);
    expect(out).toMatchObject({
      ok: true,
      setUp: true,
      pusd: '2.5',
      approvals: true,
      region: { country: 'PT', blocked: false, closeOnly: false },
      openOrders: 2,
      redeemable: { count: 1, valueUsd: '1.2' }
    });
    expect(out.pendingDeposit).toBeUndefined();
    expect(out.backup).toEqual({ backedUp: false });
    expect(out.signer).toBe('oms');
  });

  it('shows the recorded backup', async () => {
    m.account = ACCOUNT;
    writeBackup('main', BACKUP);
    const out = await run(['status']);
    expect(out.backup).toEqual({ backedUp: true, omsWalletId: 'w-imported' });
  });

  it('degrades to approvals false when the legacy check is unavailable', async () => {
    m.account = ACCOUNT;
    m.legacyApproved.mockRejectedValue(new Error('rpc down'));
    const out = await run(['status']);
    expect(out).toMatchObject({
      ok: true,
      approvals: false,
      approvalsCheck: 'unavailable',
      pusd: '2.5'
    });
  });

  it('reports approvals false when a legacy approval is missing', async () => {
    m.account = ACCOUNT;
    m.legacyApproved.mockResolvedValue(false);
    expect((await run(['status'])).approvals).toBe(false);
  });
});

describe('status paging', () => {
  it('sums redeemable positions across pages and flags truncation', async () => {
    m.account = ACCOUNT;
    m.listPositions.mockReturnValue(
      pages([{ conditionId: COND, currentValue: '1' }], [{ conditionId: COND, currentValue: '2' }])
    );
    const out = await run(['status']);
    expect(out.redeemable).toEqual({ count: 2, valueUsd: '3' });
    const big = (n: number) =>
      Array.from({ length: n }, () => ({ conditionId: COND, currentValue: '1' }));
    m.listPositions.mockReturnValue(pages(big(1500), big(1500)));
    const capped = await run(['status']);
    expect(capped.redeemable).toEqual({ count: 2000, valueUsd: '2000', truncated: true });
  });
});

describe('positions', () => {
  it('passes status, limit and cursor through and prints them back', async () => {
    m.account = ACCOUNT;
    const out = await run([
      'positions',
      '--status',
      'REDEEMABLE',
      '--limit',
      '5',
      '--cursor',
      'p1'
    ]);
    expect(m.getPositions).toHaveBeenCalledWith(WALLET, {
      status: 'REDEEMABLE',
      limit: 5,
      cursor: 'p1'
    });
    expect(out).toMatchObject({
      ok: true,
      status: 'REDEEMABLE',
      nextCursor: 'p2',
      count: 1,
      proxyWalletAddress: WALLET
    });
  });

  it('falls back to the legacy set-key proxy when no account exists', async () => {
    m.loadPolymarketKey.mockResolvedValue('0x' + '11'.repeat(32));
    const out = await run(['positions']);
    expect(m.getPositions).toHaveBeenCalledWith('0xLEGACYPROXY', expect.anything());
    expect(out.ok).toBe(true);
  });

  it('fails not_set_up with neither account nor legacy key', async () => {
    expect(await run(['positions'])).toMatchObject({ ok: false, code: 'not_set_up' });
    expect(m.getPositions).not.toHaveBeenCalled();
  });
});

describe('import-key', () => {
  const LEGACY = { kind: 'legacy-proxy', signer: '0x1', wallet: '0xLEGACYPROXY', createdAt: 'x' };

  it('reports the builder key and that withdraw moves only pUSD', async () => {
    m.importLegacyKey.mockResolvedValue({ account: LEGACY, builderKey: true });
    const out = await run(['import-key', `0x${'ab'.repeat(32)}`]);
    expect(out).toMatchObject({ ok: true, builderKey: true, account: { kind: 'legacy-proxy' } });
    expect(String(out.note)).toMatch(/USDC\.e/);
    expect(out.warning).toBeUndefined();
    expect(JSON.stringify(out)).not.toMatch(/abab/);
  });

  it('passes through the warning when the builder key could not be minted', async () => {
    m.importLegacyKey.mockResolvedValue({
      account: LEGACY,
      builderKey: false,
      warning: 'withdraw needs one: run agent polymarket setup --wallet main --broadcast'
    });
    const out = await run(['import-key', `0x${'ab'.repeat(32)}`]);
    expect(out).toMatchObject({ ok: true, builderKey: false });
    expect(String(out.warning)).toMatch(/agent polymarket setup/);
  });
});

describe('redeem', () => {
  beforeEach(() => {
    m.account = ACCOUNT;
    m.listPositions.mockReturnValue(
      pages([
        { conditionId: COND, title: 'Q', currentValue: '1.2' },
        { conditionId: COND, title: 'Q', currentValue: '0.3' }
      ])
    );
  });

  it('dry run lists de-duplicated positions without redeeming', async () => {
    const out = await run(['redeem', '--all', '--dry-run']);
    expect(out.positions).toEqual([{ conditionId: COND, title: 'Q', valueUsd: '1.5' }]);
    expect(m.redeemPositions).not.toHaveBeenCalled();
  });

  it('--all --broadcast redeems a shared condition id once', async () => {
    const out = await run(['redeem', '--all', '--broadcast']);
    expect(m.redeemPositions).toHaveBeenCalledTimes(1);
    expect(m.redeemPositions).toHaveBeenCalledWith({ conditionId: COND });
    expect(out).toEqual({
      ok: true,
      redeemed: [{ conditionId: COND, txHash: '0xTX' }],
      failed: []
    });
  });

  it('one failure does not stop the others', async () => {
    const other = '0x' + 'cd'.repeat(32);
    m.listPositions.mockReturnValue(
      pages([
        { conditionId: COND, currentValue: '1' },
        { conditionId: other, currentValue: '1' }
      ])
    );
    m.redeemPositions
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ wait: async () => ({ transactionHash: '0xOK' }) });
    const out = await run(['redeem', '--all', '--broadcast']);
    expect(out.redeemed).toEqual([{ conditionId: other, txHash: '0xOK' }]);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].conditionId).toBe(COND);
    expect(out.ok).toBe(true);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('fails non-zero with upstream_error when every redemption failed', async () => {
    m.redeemPositions.mockRejectedValue(new Error('relayer down'));
    const out = await run(['redeem', '--all', '--broadcast']);
    expect(out).toMatchObject({
      ok: false,
      code: 'upstream_error',
      redeemed: [],
      failed: [{ conditionId: COND, error: 'relayer down' }]
    });
    expect(String(out.error)).toBeTruthy();
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(vi.mocked(console.log)).not.toHaveBeenCalled();
  });

  it('an empty --all is still ok', async () => {
    m.listPositions.mockReturnValue(pages([]));
    const out = await run(['redeem', '--all', '--broadcast']);
    expect(out).toEqual({ ok: true, redeemed: [], failed: [] });
  });

  it('reads every page and de-duplicates across them', async () => {
    const other = '0x' + 'cd'.repeat(32);
    m.listPositions.mockReturnValue(
      pages(
        [{ conditionId: COND, currentValue: '1' }],
        [
          { conditionId: COND, currentValue: '2' },
          { conditionId: other, currentValue: '4' }
        ]
      )
    );
    const out = await run(['redeem', '--all', '--dry-run']);
    expect(out.positions).toEqual([
      { conditionId: COND, title: null, valueUsd: '3' },
      { conditionId: other, title: null, valueUsd: '4' }
    ]);
    expect(out.truncated).toBeUndefined();
  });

  it('flags truncation when the row cap is hit with pages left', async () => {
    const rows = (from: number) =>
      Array.from({ length: 1000 }, (_, i) => ({
        conditionId: '0x' + (from + i).toString(16).padStart(64, '0'),
        currentValue: '1'
      }));
    m.listPositions.mockReturnValue(pages(rows(0), rows(1000), rows(2000)));
    const out = await run(['redeem', '--all', '--dry-run']);
    expect(out.count).toBe(2000);
    expect(out.truncated).toBe(true);
  });

  it('needs a market or --all', async () => {
    expect(await run(['redeem', '--dry-run'])).toMatchObject({ code: 'invalid_input' });
  });
});

describe('activity and pnl', () => {
  it('maps activity rows', async () => {
    m.account = ACCOUNT;
    const out = await run(['activity']);
    expect(out.nextCursor).toBe('n1');
    expect(out.items[0]).toMatchObject({
      type: 'TRADE',
      time: '1970-01-01T00:00:00.000Z',
      side: 'BUY',
      txHash: '0xh'
    });
  });

  it('reports value and the last point', async () => {
    m.account = ACCOUNT;
    const out = await run(['pnl', '--interval', '1w']);
    expect(out).toMatchObject({
      valueUsd: '9.5',
      interval: '1w',
      realized: '3',
      unrealized: '4'
    });
    expect(out.points).toHaveLength(2);
  });
});

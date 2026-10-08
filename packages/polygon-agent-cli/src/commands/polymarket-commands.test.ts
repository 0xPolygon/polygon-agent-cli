// Polymarket command surface after the Data API v2 / Gamma keyset migration:
// cursors instead of offsets, position status filters, one approval batch for
// every CLOB exchange, and a clear refusal for markets the CLI can't trade.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as PolymarketLib from '../lib/polymarket.ts';

const mocks = vi.hoisted(() => ({
  getMarkets: vi.fn(),
  getMarket: vi.fn(),
  getPositions: vi.fn(),
  loadPolymarketKey: vi.fn()
}));

vi.mock('../lib/polymarket.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof PolymarketLib>()),
  getMarkets: mocks.getMarkets,
  getMarket: mocks.getMarket,
  getPositions: mocks.getPositions,
  getPolymarketProxyWalletAddress: async () => '0x2222222222222222222222222222222222222222'
}));

vi.mock('../lib/storage.ts', () => ({
  loadOmsWalletPointer: vi.fn(),
  savePolymarketKey: vi.fn(),
  loadPolymarketKey: mocks.loadPolymarketKey
}));

vi.mock('../lib/tx-dispatch.ts', () => ({ runTx: vi.fn() }));

const { polymarketCommand } = await import('./polymarket.ts');
const lib = await import('../lib/polymarket.ts');

const PK = `0x${'11'.repeat(32)}`;

const V1 = lib.parseMarket({
  conditionId: '0xc1',
  question: 'Q?',
  version: 'v1',
  clobTokenIds: '["1","2"]',
  outcomePrices: '["0.4","0.6"]',
  acceptingOrders: true
});

// Write commands always pass --dry-run: without it they follow the persisted
// transaction mode and could broadcast.
async function run(argv: string[]): Promise<Record<string, unknown>> {
  const yargs = (await import('yargs')).default;
  await yargs()
    .command(polymarketCommand)
    .parseAsync(['polymarket', ...argv])
    .catch(() => undefined);
  const lines = [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls]
    .map((call) => String(call[0]))
    .filter((line) => line.trimStart().startsWith('{'));
  return JSON.parse(lines.at(-1) ?? '{}');
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  mocks.loadPolymarketKey.mockResolvedValue(PK);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('polymarket markets', () => {
  it('returns the next cursor and passes --cursor through', async () => {
    mocks.getMarkets.mockResolvedValue({ markets: [V1], nextCursor: 'next' });
    const out = await run(['markets', '--cursor', 'abc', '--limit', '5']);
    expect(mocks.getMarkets).toHaveBeenCalledWith({ search: undefined, limit: 5, cursor: 'abc' });
    expect(out).toMatchObject({ ok: true, count: 1, nextCursor: 'next' });
  });

  it('rejects --offset, which Gamma no longer supports, and points at --cursor', async () => {
    const out = await run(['markets', '--offset', '20']);
    expect(mocks.getMarkets).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: false, code: 'offset_removed' });
    expect(String(out.error)).toMatch(/--cursor/);
  });
});

describe('polymarket positions', () => {
  it('passes status, limit and cursor through and returns the next cursor', async () => {
    mocks.getPositions.mockResolvedValue({ positions: [{ token_id: '1' }], nextCursor: 'p2' });
    const out = await run([
      'positions',
      '--status',
      'REDEEMABLE',
      '--limit',
      '5',
      '--cursor',
      'p1'
    ]);
    expect(mocks.getPositions).toHaveBeenCalledWith('0x2222222222222222222222222222222222222222', {
      status: 'REDEEMABLE',
      limit: 5,
      cursor: 'p1'
    });
    expect(out).toMatchObject({ ok: true, count: 1, nextCursor: 'p2', status: 'REDEEMABLE' });
  });
});

describe('polymarket approve', () => {
  it('approves pUSD and outcome tokens for every exchange in one batch, with no adapter', async () => {
    const out = await run(['approve', '--dry-run']);
    expect(out).toMatchObject({ ok: true, dryRun: true });
    const approvals = out.approvals as string[];
    expect(approvals).toEqual([
      'pUSD → CTF Exchange',
      'pUSD → Neg Risk CTF Exchange',
      'pUSD → Polymarket V2 Exchange',
      'Conditional Tokens → CTF Exchange',
      'Conditional Tokens → Neg Risk CTF Exchange',
      'PositionManager → Polymarket V2 Exchange',
      'USDC.e → CollateralOnramp (for wrapping)'
    ]);
    expect(approvals.join(' ')).not.toMatch(/Adapter/i);
  });

  it('still accepts the old --neg-risk flag and sets the same approvals', async () => {
    const out = await run(['approve', '--neg-risk', '--dry-run']);
    expect((out.approvals as string[]).length).toBe(7);
  });
});

describe('trading refusals', () => {
  it('refuses to buy on a Polymarket V2 market, even as a dry run', async () => {
    mocks.getMarket.mockResolvedValue({ ...V1, version: 'v2' });
    const out = await run(['clob-buy', '0xc1', 'YES', '5', '--dry-run']);
    expect(out).toMatchObject({ ok: false, code: 'unsupported_market_version' });
  });

  it('refuses to sell on a closed market', async () => {
    mocks.getMarket.mockResolvedValue({ ...V1, closed: true });
    const out = await run(['sell', '0xc1', 'YES', '5', '--dry-run']);
    expect(out).toMatchObject({ ok: false, code: 'market_not_accepting_orders' });
  });

  it('dry-runs a buy on a V1 market', async () => {
    mocks.getMarket.mockResolvedValue(V1);
    const out = await run(['clob-buy', '0xc1', 'YES', '5', '--dry-run']);
    expect(out).toMatchObject({ ok: true, dryRun: true, tokenId: '1' });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  buy: vi.fn(),
  sell: vi.fn(),
  cancelAll: vi.fn(),
  cancelOrder: vi.fn(),
  cancelMarketOrders: vi.fn(),
  listOpenOrders: vi.fn()
}));

vi.mock('../../lib/polymarket/orders.ts', () => ({ buy: m.buy, sell: m.sell }));
vi.mock('../../lib/polymarket/account.ts', async (o) => ({
  ...(await o<Record<string, unknown>>()),
  getTradingClient: async () => ({
    cancelAll: m.cancelAll,
    cancelOrder: m.cancelOrder,
    cancelMarketOrders: m.cancelMarketOrders,
    listOpenOrders: m.listOpenOrders
  })
}));

const { buyCommand, sellCommand, ordersCommand, cancelCommand } = await import('./trade.ts');

async function run(argv: string[]) {
  const yargs = (await import('yargs')).default;
  await yargs()
    .command(buyCommand)
    .command(sellCommand)
    .command(ordersCommand)
    .command(cancelCommand)
    .fail(false)
    .parseAsync(argv)
    .catch(() => undefined);
  const lines = [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls]
    .map((c) => String(c[0]))
    .filter((l) => l.trimStart().startsWith('{'));
  return JSON.parse(lines.at(-1) ?? '{}');
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('cancel', () => {
  it('fails invalid_input when given nothing to cancel', async () => {
    const out = await run(['cancel', '--broadcast']);
    expect(out).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(m.cancelAll).not.toHaveBeenCalled();
  });

  it('fails invalid_input when given more than one target', async () => {
    const out = await run(['cancel', 'o1', '--all', '--broadcast']);
    expect(out).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(m.cancelOrder).not.toHaveBeenCalled();
    expect(m.cancelAll).not.toHaveBeenCalled();
  });

  it('--all --broadcast calls cancelAll once', async () => {
    m.cancelAll.mockResolvedValue({ canceled: ['o1', 'o2'], notCanceled: {} });
    const out = await run(['cancel', '--all', '--broadcast']);
    expect(m.cancelAll).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ ok: true, canceled: ['o1', 'o2'], notCanceled: {} });
  });

  it('--dry-run lists what would be cancelled and cancels nothing', async () => {
    m.listOpenOrders.mockReturnValue({
      firstPage: async () => ({
        items: [
          {
            id: 'o1',
            conditionId: '0xc',
            outcome: 'Yes',
            side: 'BUY',
            price: '0.4',
            originalSize: '10',
            sizeMatched: '0'
          }
        ]
      })
    });
    const out = await run(['cancel', '--all', '--dry-run']);
    expect(m.cancelAll).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, dryRun: true, wouldCancel: 1 });
  });
});

describe('buy / sell', () => {
  it('buy --dry-run passes broadcast:false to buy', async () => {
    m.buy.mockResolvedValue({ dryRun: true });
    const out = await run(['buy', 'will-x', 'yes', '5', '--max-price', '0.55', '--dry-run']);
    expect(m.buy).toHaveBeenCalledWith(
      expect.objectContaining({
        wallet: 'main',
        ref: 'will-x',
        outcome: 'yes',
        usd: '5',
        maxPrice: 0.55,
        broadcast: false
      })
    );
    expect(out).toMatchObject({ ok: true, dryRun: true });
  });

  it('sell --broadcast passes broadcast:true and the min price to sell', async () => {
    m.sell.mockResolvedValue({ orderId: 'o9' });
    await run(['sell', 'will-x', 'no', 'all', '--min-price', '0.3', '--broadcast']);
    expect(m.sell).toHaveBeenCalledWith(
      expect.objectContaining({ shares: 'all', minPrice: 0.3, broadcast: true })
    );
  });
});

describe('orders', () => {
  it('lists open orders in the summary shape', async () => {
    m.listOpenOrders.mockReturnValue({
      firstPage: async () => ({
        items: [
          {
            id: 'o1',
            conditionId: '0xc',
            outcome: 'Yes',
            side: 'BUY',
            price: '0.4',
            originalSize: '10',
            sizeMatched: '2'
          }
        ]
      })
    });
    const out = await run(['orders']);
    expect(out).toMatchObject({
      ok: true,
      count: 1,
      orders: [{ id: 'o1', market: '0xc', size: '10', filled: '2', expiresAt: null }]
    });
  });
});

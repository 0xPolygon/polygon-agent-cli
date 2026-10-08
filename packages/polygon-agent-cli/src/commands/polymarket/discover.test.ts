import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  resolved: vi.fn(),
  lookupSlug: vi.fn(),
  client: { fetchOrderBook: vi.fn(), listPriceHistory: vi.fn(), fetchEvent: vi.fn() }
}));

vi.mock('../../lib/polymarket/resolve.ts', async (o) => ({
  ...(await o<Record<string, unknown>>()),
  resolveOutcome: m.resolved,
  lookupSlug: m.lookupSlug,
  publicClient: async () => m.client
}));
vi.mock('../../lib/polymarket/gamma.ts', async (o) => ({
  ...(await o<Record<string, unknown>>()),
  getMarkets: vi.fn()
}));

const { marketsCommand, eventCommand, marketCommand, bookCommand, historyCommand } =
  await import('./discover.ts');

async function run(argv: string[]) {
  const yargs = (await import('yargs')).default;
  await yargs()
    .command(marketsCommand)
    .command(eventCommand)
    .command(marketCommand)
    .command(bookCommand)
    .command(historyCommand)
    .fail(false)
    .parseAsync(argv)
    .catch(() => undefined);
  const lines = [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls]
    .map((c) => String(c[0]))
    .filter((l) => l.trimStart().startsWith('{'));
  return JSON.parse(lines.at(-1) ?? '{}');
}

const resolvedYes = {
  assetId: 'T',
  market: { slug: 'will-x' },
  outcome: 'yes',
  label: 'Yes',
  price: '0.5'
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('discover commands', () => {
  it('book returns best-first sides', async () => {
    m.resolved.mockResolvedValue(resolvedYes);
    m.client.fetchOrderBook.mockResolvedValue({
      bids: [
        { price: '0.1', size: '1' },
        { price: '0.4', size: '2' }
      ],
      asks: [
        { price: '0.9', size: '1' },
        { price: '0.5', size: '3' }
      ],
      minOrderSize: '5',
      tickSize: 0.01
    });
    const out = await run(['book', 'will-x', 'yes', '--depth', '1']);
    expect(out).toMatchObject({
      ok: true,
      bestBid: '0.4',
      bestAsk: '0.5',
      spread: '0.1',
      bids: [{ price: '0.4', size: '2' }],
      asks: [{ price: '0.5', size: '3' }]
    });
  });

  it('history downsamples to --points and keeps the last point', async () => {
    m.resolved.mockResolvedValue(resolvedYes);
    const items = Array.from({ length: 100 }, (_, i) => ({
      timestamp: 1_700_000_000_000 + i * 60_000,
      price: String(i / 100)
    }));
    m.client.listPriceHistory.mockReturnValue({ firstPage: async () => ({ items }) });
    const out = await run(['history', 'will-x', 'yes', '--points', '10']);
    expect(out.points).toHaveLength(10);
    expect(out.points.at(-1).price).toBe('0.99');
  });

  it('event lists open markets only by default', async () => {
    m.client.fetchEvent.mockResolvedValue({
      id: 'e',
      slug: 'e',
      title: 'E',
      markets: [
        { id: '1', state: { closed: false, acceptingOrders: true }, outcomes: {} },
        { id: '2', state: { closed: true }, outcomes: {} }
      ]
    });
    const out = await run(['event', 'e']);
    expect(out.markets.map((x: { id: string }) => x.id)).toEqual(['1']);
    const all = await run(['event', 'e', '--all']);
    expect(all.markets).toHaveLength(2);
  });

  it('market falls back to listing an event slug', async () => {
    m.lookupSlug.mockResolvedValue({
      event: { id: 'e', slug: 'e', title: 'E', markets: [{ id: '1', state: {}, outcomes: {} }] }
    });
    const out = await run(['market', 'e']);
    expect(out).toMatchObject({ ok: true, event: { slug: 'e' }, count: 1 });
  });

  it('markets --offset fails with offset_removed', async () => {
    const out = await run(['markets', '--offset', '20']);
    expect(out).toMatchObject({ ok: false, code: 'offset_removed' });
  });
});

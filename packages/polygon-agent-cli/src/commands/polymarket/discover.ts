// Discovery commands: markets, event, market, book, history. All read-only.

import type { CommandModule } from 'yargs';

import type { SdkEvent } from '../../lib/polymarket/resolve.ts';

import { PolymarketError, getMarkets } from '../../lib/polymarket/gamma.ts';
import {
  lookupSlug,
  publicClient,
  resolveOutcome,
  summarizeMarket
} from '../../lib/polymarket/resolve.ts';
import { mapSdkError } from '../../lib/polymarket/sdk.ts';
import { fail, ok } from './shared.ts';

const INTERVALS = ['1h', '6h', '1d', '1w', '1m', 'max'] as const;

type Interval = (typeof INTERVALS)[number];

async function handleMarkets(argv: {
  search?: string;
  limit?: number;
  cursor?: string;
  offset?: number;
}): Promise<void> {
  try {
    if (argv.offset) {
      throw new PolymarketError(
        'offset_removed',
        "Polymarket removed offset paging. Pass the previous response's nextCursor as --cursor instead."
      );
    }
    const { markets, nextCursor } = await getMarkets({
      search: argv.search,
      limit: argv.limit ?? 20,
      cursor: argv.cursor
    });
    ok({ count: markets.length, nextCursor, markets });
  } catch (err) {
    fail(err);
  }
}

function printEvent(ev: SdkEvent, all: boolean | undefined): void {
  const markets = (ev.markets ?? []).filter(
    (m: { state?: { closed?: boolean } }) => all || !m.state?.closed
  );
  ok({
    event: {
      id: ev.id,
      slug: ev.slug,
      title: ev.title,
      endDate: ev.schedule?.endDate ?? null,
      negRisk: !!ev.trading?.negRisk
    },
    count: markets.length,
    markets: markets.map(summarizeMarket)
  });
}

async function handleEvent(argv: { slug: string; all?: boolean }): Promise<void> {
  try {
    const c = await publicClient();
    const ev = await c.fetchEvent({ slug: argv.slug }).catch((e: unknown) => {
      throw mapSdkError(e);
    });
    printEvent(ev, argv.all);
  } catch (err) {
    fail(err);
  }
}

async function handleMarket(argv: { ref: string; all?: boolean }): Promise<void> {
  try {
    if (/^0x[0-9a-fA-F]{64}$/.test(argv.ref)) {
      // A conditionId always names one market.
      const r = await resolveOutcome(argv.ref, 'yes');
      ok({ market: summarizeMarket(r.market) });
      return;
    }
    const found = await lookupSlug(argv.ref);
    if (found.market) ok({ market: summarizeMarket(found.market) });
    else if (found.event) printEvent(found.event, argv.all);
    else
      throw new PolymarketError('outcome_not_found', `No market or event with slug '${argv.ref}'.`);
  } catch (err) {
    fail(err);
  }
}

async function handleBook(argv: { ref: string; outcome: string; depth: number }): Promise<void> {
  try {
    const r = await resolveOutcome(argv.ref, argv.outcome);
    const c = await publicClient();
    const book = await c.fetchOrderBook({ assetId: r.assetId }).catch((e: unknown) => {
      throw mapSdkError(e);
    });
    // The SDK returns both sides best-last.
    const bids = [...book.bids].reverse().slice(0, argv.depth);
    const asks = [...book.asks].reverse().slice(0, argv.depth);
    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;
    const spread =
      bestBid && bestAsk
        ? String(Math.round((Number(bestAsk) - Number(bestBid)) * 1e6) / 1e6)
        : null;
    ok({
      market: r.market.slug,
      outcome: r.label,
      assetId: r.assetId,
      bestBid,
      bestAsk,
      spread,
      bids,
      asks,
      minOrderSize: book.minOrderSize,
      tickSize: book.tickSize
    });
  } catch (err) {
    fail(err);
  }
}

async function handleHistory(argv: {
  ref: string;
  outcome: string;
  interval: Interval;
  points: number;
}): Promise<void> {
  try {
    const r = await resolveOutcome(argv.ref, argv.outcome);
    const c = await publicClient();
    const page = await c
      .listPriceHistory({ assetId: r.assetId, interval: argv.interval })
      .firstPage()
      .catch((e: unknown) => {
        throw mapSdkError(e);
      });
    const items = page.items as Array<{ timestamp: number; price: string }>;
    const step = Math.max(1, Math.ceil(items.length / argv.points));
    const sampled = items
      .filter((_, i) => i % step === 0 || i === items.length - 1)
      .slice(-argv.points);
    ok({
      market: r.market.slug,
      outcome: r.label,
      interval: argv.interval,
      points: sampled.map((p) => ({ t: new Date(p.timestamp).toISOString(), price: p.price }))
    });
  } catch (err) {
    fail(err);
  }
}

export const marketsCommand: CommandModule = {
  command: 'markets',
  describe: 'List active markets by volume',
  builder: (y) =>
    y
      .option('search', { type: 'string', describe: 'Filter by question text' })
      .option('limit', { type: 'number', default: 20, describe: 'Number of results' })
      .option('cursor', {
        type: 'string',
        describe: 'nextCursor from the previous page (listing only, not --search)'
      })
      .option('offset', { type: 'number', hidden: true, deprecated: 'use --cursor' }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleMarkets(argv as any)
};

export const eventCommand: CommandModule = {
  command: 'event <slug>',
  describe: 'Show an event and its open markets',
  builder: (y) =>
    y
      .positional('slug', { type: 'string', demandOption: true, describe: 'Event slug' })
      .option('all', { type: 'boolean', default: false, describe: 'Include closed markets' }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleEvent(argv as any)
};

export const marketCommand: CommandModule = {
  command: 'market <ref>',
  describe: 'Show a market by conditionId or slug (an event slug lists its markets)',
  builder: (y) =>
    y
      .positional('ref', {
        type: 'string',
        demandOption: true,
        describe: 'conditionId, market slug or event slug'
      })
      .option('all', { type: 'boolean', default: false, describe: 'Include closed markets' }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleMarket(argv as any)
};

export const bookCommand: CommandModule = {
  command: 'book <ref> <outcome>',
  describe: 'Show the order book for one outcome',
  builder: (y) =>
    y
      .positional('ref', { type: 'string', demandOption: true, describe: 'Market ref' })
      .positional('outcome', { type: 'string', demandOption: true, describe: 'yes, no or a name' })
      .option('depth', { type: 'number', default: 10, describe: 'Levels per side' }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleBook(argv as any)
};

export const historyCommand: CommandModule = {
  command: 'history <ref> <outcome>',
  describe: 'Show price history for one outcome',
  builder: (y) =>
    y
      .positional('ref', { type: 'string', demandOption: true, describe: 'Market ref' })
      .positional('outcome', { type: 'string', demandOption: true, describe: 'yes, no or a name' })
      .option('interval', { type: 'string', choices: INTERVALS, default: '1d' })
      .option('points', { type: 'number', default: 60, describe: 'Max points returned' }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleHistory(argv as any)
};

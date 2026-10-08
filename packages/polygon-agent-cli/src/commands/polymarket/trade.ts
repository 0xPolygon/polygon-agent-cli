// buy / sell / orders / cancel: trading on the Polymarket account.

import type { Argv, CommandModule } from 'yargs';

import { CliError } from '../../lib/errors.ts';
import { resolveBroadcast, withWriteFlags } from '../../lib/mode.ts';
import { getTradingClient } from '../../lib/polymarket/account.ts';
import { buy, sell } from '../../lib/polymarket/orders.ts';
import { resolveOutcome } from '../../lib/polymarket/resolve.ts';
import { loadSdk, mapSdkError } from '../../lib/polymarket/sdk.ts';
import { fail, ok, walletOption } from './shared.ts';

type OpenOrderRow = {
  id: string;
  conditionId: string;
  outcome: string;
  side: string;
  price: string;
  originalSize: string;
  sizeMatched: string;
  expiresAt?: string;
};

const summarize = (o: OpenOrderRow) => ({
  id: o.id,
  market: o.conditionId,
  outcome: o.outcome,
  side: o.side,
  price: o.price,
  size: o.originalSize,
  filled: o.sizeMatched,
  expiresAt: o.expiresAt ?? null
});

async function conditionIdOf(ref: string): Promise<string> {
  return (await resolveOutcome(ref, 'yes')).market.conditionId;
}

type BuyArgs = {
  ref: string;
  outcome: string;
  usd: string;
  wallet: string;
  maxPrice?: number;
  price?: number;
  expires?: number;
  broadcast?: boolean;
  dryRun?: boolean;
};

async function handleBuy(argv: BuyArgs): Promise<void> {
  try {
    ok(
      await buy({
        wallet: argv.wallet,
        ref: argv.ref,
        outcome: argv.outcome,
        usd: String(argv.usd),
        maxPrice: argv.maxPrice,
        limitPrice: argv.price,
        expiresMinutes: argv.expires,
        broadcast: resolveBroadcast(argv)
      })
    );
  } catch (err) {
    fail(err, { stack: true });
  }
}

type SellArgs = {
  ref: string;
  outcome: string;
  shares: string;
  wallet: string;
  minPrice?: number;
  price?: number;
  expires?: number;
  broadcast?: boolean;
  dryRun?: boolean;
};

async function handleSell(argv: SellArgs): Promise<void> {
  try {
    ok(
      await sell({
        wallet: argv.wallet,
        ref: argv.ref,
        outcome: argv.outcome,
        shares: String(argv.shares),
        minPrice: argv.minPrice,
        limitPrice: argv.price,
        expiresMinutes: argv.expires,
        broadcast: resolveBroadcast(argv)
      })
    );
  } catch (err) {
    fail(err, { stack: true });
  }
}

async function handleOrders(argv: { wallet: string; market?: string }): Promise<void> {
  try {
    await loadSdk();
    const client = await getTradingClient(argv.wallet);
    const market = argv.market ? await conditionIdOf(argv.market) : undefined;
    const page = await client.listOpenOrders(market ? { market } : {}).firstPage();
    const items = page.items as OpenOrderRow[];
    ok({ count: items.length, orders: items.map(summarize) });
  } catch (err) {
    fail(mapSdkError(err), { stack: true });
  }
}

type CancelArgs = {
  orderId?: string;
  all?: boolean;
  market?: string;
  wallet: string;
  broadcast?: boolean;
  dryRun?: boolean;
};

async function handleCancel(argv: CancelArgs): Promise<void> {
  try {
    const chosen = [argv.orderId, argv.all || undefined, argv.market].filter(
      (v) => v !== undefined
    );
    if (chosen.length !== 1) {
      throw new CliError({
        code: 'invalid_input',
        message: 'Pass exactly one of an order id, --all, or --market <ref>.'
      });
    }
    const broadcast = resolveBroadcast(argv);
    await loadSdk();
    const client = await getTradingClient(argv.wallet);
    const market = argv.market ? await conditionIdOf(argv.market) : undefined;
    if (!broadcast) {
      const query = argv.orderId ? { id: argv.orderId } : market ? { market } : {};
      const page = await client.listOpenOrders(query).firstPage();
      const items = page.items as OpenOrderRow[];
      ok({ dryRun: true, wouldCancel: items.length, orders: items.map(summarize) });
      return;
    }
    const res = argv.orderId
      ? await client.cancelOrder({ orderId: argv.orderId })
      : argv.all
        ? await client.cancelAll()
        : await client.cancelMarketOrders({ market });
    ok({ canceled: res.canceled, notCanceled: res.notCanceled });
  } catch (err) {
    fail(mapSdkError(err), { stack: true });
  }
}

const refPositionals = <T>(y: Argv<T>) =>
  y
    .positional('ref', {
      type: 'string',
      demandOption: true,
      describe: 'Market slug or condition id'
    })
    .positional('outcome', {
      type: 'string',
      demandOption: true,
      describe: 'yes, no, or the outcome name'
    });

export const buyCommand: CommandModule = {
  command: 'buy <ref> <outcome> <usd>',
  describe: 'Buy outcome shares with a USD amount (market order, or limit with --price)',
  builder: (y) =>
    withWriteFlags(
      walletOption(refPositionals(y))
        .positional('usd', { type: 'string', demandOption: true, describe: 'USD to spend' })
        .option('max-price', {
          type: 'number',
          describe: 'Refuse if the fill would be worse than this price (0-1)'
        })
        .option('price', {
          type: 'number',
          describe: 'Limit price (0-1); places a resting limit order'
        })
        .option('expires', { type: 'number', describe: 'Limit order lifetime in minutes (min 3)' })
    ),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleBuy(argv as any)
};

export const sellCommand: CommandModule = {
  command: 'sell <ref> <outcome> <shares>',
  describe: "Sell outcome shares (a number, or 'all')",
  builder: (y) =>
    withWriteFlags(
      walletOption(refPositionals(y))
        .positional('shares', { type: 'string', demandOption: true, describe: "Shares or 'all'" })
        .option('min-price', {
          type: 'number',
          describe: 'Refuse if the fill would be worse than this price (0-1)'
        })
        .option('price', {
          type: 'number',
          describe: 'Limit price (0-1); places a resting limit order'
        })
        .option('expires', { type: 'number', describe: 'Limit order lifetime in minutes (min 3)' })
    ),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleSell(argv as any)
};

export const ordersCommand: CommandModule = {
  command: 'orders',
  describe: 'List open orders',
  builder: (y) =>
    walletOption(y).option('market', {
      type: 'string',
      describe: 'Only this market (slug or condition id)'
    }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleOrders(argv as any)
};

export const cancelCommand: CommandModule = {
  command: 'cancel [orderId]',
  describe: 'Cancel one order, all orders, or all orders in a market',
  builder: (y) =>
    withWriteFlags(
      walletOption(y)
        .positional('orderId', { type: 'string', describe: 'Order id' })
        .option('all', { type: 'boolean', default: false, describe: 'Cancel every open order' })
        .option('market', { type: 'string', describe: 'Cancel every open order in this market' })
    ),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleCancel(argv as any)
};

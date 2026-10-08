// positions / redeem / activity / pnl: reading and settling the Polymarket portfolio.

import type { CommandModule } from 'yargs';

import type { PositionStatus } from '../../lib/polymarket/gamma.ts';

import { CliError } from '../../lib/errors.ts';
import { resolveBroadcast, withWriteFlags } from '../../lib/mode.ts';
import { getTradingClient, loadAccount, requireAccount } from '../../lib/polymarket/account.ts';
import {
  getPolymarketProxyWalletAddress,
  getPositions,
  POSITION_STATUSES
} from '../../lib/polymarket/gamma.ts';
import { assertCanTrade, checkRegion } from '../../lib/polymarket/region.ts';
import { resolveOutcome } from '../../lib/polymarket/resolve.ts';
import { mapSdkError } from '../../lib/polymarket/sdk.ts';
import { loadPolymarketKey } from '../../lib/storage.ts';
import { fail, ok, walletOption } from './shared.ts';

type PositionsArgs = { status?: PositionStatus; limit?: number; cursor?: string; wallet: string };

// The address to read positions for. Installs that predate `setup` but ran the old
// `set-key` stay readable through the proxy wallet derived from that key. Read-only:
// nothing is created here.
async function positionsAddress(wallet: string): Promise<string> {
  if (loadAccount(wallet)) return requireAccount(wallet).wallet;
  let key: string;
  try {
    key = await loadPolymarketKey();
  } catch {
    return requireAccount(wallet).wallet; // throws not_set_up
  }
  const { privateKeyToAccount } = await import('viem/accounts');
  return getPolymarketProxyWalletAddress(privateKeyToAccount(key as `0x${string}`).address);
}

async function handlePositions(argv: PositionsArgs): Promise<void> {
  try {
    const proxyWalletAddress = await positionsAddress(argv.wallet);
    const status = argv.status ?? 'OPEN';
    const { positions, nextCursor } = await getPositions(proxyWalletAddress, {
      status,
      limit: argv.limit ?? 20,
      cursor: argv.cursor
    });
    ok({ proxyWalletAddress, status, count: positions.length, nextCursor, positions });
  } catch (err) {
    fail(err, { stack: true });
  }
}

type RedeemArgs = {
  ref?: string;
  all?: boolean;
  wallet: string;
  broadcast?: boolean;
  dryRun?: boolean;
};
type Redeemable = { conditionId: string; title: string | null; valueUsd: string };

async function redeemablePositions(client: {
  listPositions(req: object): { firstPage(): Promise<{ items: unknown[] }> };
}): Promise<Redeemable[]> {
  const page = await client.listPositions({ status: 'REDEEMABLE', pageSize: 500 }).firstPage();
  const byCondition = new Map<string, Redeemable & { total: number }>();
  for (const p of page.items as Array<{
    conditionId: string;
    title?: string;
    currentValue: string;
  }>) {
    const seen = byCondition.get(p.conditionId);
    const total = (seen?.total ?? 0) + Number(p.currentValue);
    byCondition.set(p.conditionId, {
      conditionId: p.conditionId,
      title: seen?.title ?? p.title ?? null,
      valueUsd: String(total),
      total
    });
  }
  return [...byCondition.values()].map(({ conditionId, title, valueUsd }) => ({
    conditionId,
    title,
    valueUsd
  }));
}

async function handleRedeem(argv: RedeemArgs): Promise<void> {
  try {
    const broadcast = resolveBroadcast(argv);
    if (!argv.all && !argv.ref) {
      throw new CliError({
        code: 'invalid_input',
        message: 'Pass a market to redeem, or --all.',
        hint: 'agent polymarket redeem --all'
      });
    }
    requireAccount(argv.wallet);
    assertCanTrade(await checkRegion());
    const client = await getTradingClient(argv.wallet);
    const redeemable = await redeemablePositions(client).catch((e) => {
      throw mapSdkError(e);
    });
    let targets: Redeemable[];
    if (argv.all) {
      targets = redeemable;
    } else {
      const { market } = await resolveOutcome(argv.ref as string, 'yes');
      const known = redeemable.find((r) => r.conditionId === market.conditionId);
      targets = [
        known ?? { conditionId: market.conditionId, title: market.question ?? null, valueUsd: '0' }
      ];
    }
    if (!broadcast) {
      ok({ dryRun: true, count: targets.length, positions: targets });
      return;
    }
    const redeemed: Array<{ conditionId: string; txHash: string | null }> = [];
    const failed: Array<{ conditionId: string; error: string }> = [];
    for (const t of targets) {
      try {
        const handle = await client.redeemPositions({ conditionId: t.conditionId });
        const outcome = await handle.wait();
        redeemed.push({ conditionId: t.conditionId, txHash: outcome?.transactionHash ?? null });
      } catch (err) {
        failed.push({ conditionId: t.conditionId, error: (mapSdkError(err) as Error).message });
      }
    }
    ok({ redeemed, failed });
  } catch (err) {
    fail(err, { stack: true });
  }
}

type ActivityRow = {
  type: string;
  timestamp: number;
  title?: string;
  outcome?: string;
  side?: string;
  shares?: string;
  amount?: string;
  price?: string;
  transactionHash?: string;
};

async function handleActivity(argv: {
  limit?: number;
  cursor?: string;
  wallet: string;
}): Promise<void> {
  try {
    requireAccount(argv.wallet);
    const client = await getTradingClient(argv.wallet);
    try {
      const page = await client
        .listActivity({ pageSize: argv.limit ?? 20, cursor: argv.cursor })
        .firstPage();
      ok({
        items: (page.items as ActivityRow[]).map((a) => ({
          type: a.type,
          time: new Date(a.timestamp).toISOString(),
          title: a.title ?? null,
          outcome: a.outcome ?? null,
          side: a.side ?? null,
          shares: a.shares ?? null,
          amount: a.amount ?? null,
          price: a.price ?? null,
          txHash: a.transactionHash ?? null
        })),
        nextCursor: page.nextCursor ?? null
      });
    } catch (err) {
      throw mapSdkError(err);
    }
  } catch (err) {
    fail(err, { stack: true });
  }
}

const MAX_POINTS = 30;

function sample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = (items.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => items[Math.round(i * step)]);
}

async function handlePnl(argv: { interval?: string; wallet: string }): Promise<void> {
  try {
    requireAccount(argv.wallet);
    const client = await getTradingClient(argv.wallet);
    const interval = argv.interval ?? '1m';
    try {
      const [series, portfolio] = await Promise.all([
        client.fetchUserPnl({ interval }),
        client.fetchPortfolioValue()
      ]);
      const points = series.points as Array<{
        timestamp: number;
        realizedPnl: string;
        unrealizedPnl: string | null;
      }>;
      const last = points.at(-1);
      ok({
        valueUsd: portfolio.value,
        interval,
        realized: last?.realizedPnl ?? null,
        unrealized: last?.unrealizedPnl ?? null,
        points: sample(points, MAX_POINTS)
      });
    } catch (err) {
      throw mapSdkError(err);
    }
  } catch (err) {
    fail(err, { stack: true });
  }
}

export const positionsCommand: CommandModule = {
  command: 'positions',
  describe: 'List positions for the Polymarket account',
  builder: (y) =>
    walletOption(y)
      .option('status', {
        type: 'string',
        choices: POSITION_STATUSES,
        default: 'OPEN',
        describe:
          'OPEN (includes unredeemed winners), REDEEMABLE, REDEEMABLE_LOST, MERGEABLE or CLOSED'
      })
      .option('limit', { type: 'number', default: 20, describe: 'Rows per page (max 1000)' })
      .option('cursor', { type: 'string', describe: 'nextCursor from the previous page' }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handlePositions(argv as any)
};

export const redeemCommand: CommandModule = {
  command: 'redeem [ref]',
  describe: 'Redeem winning positions (one market, or --all)',
  builder: (y) =>
    withWriteFlags(
      walletOption(y)
        .positional('ref', { type: 'string', describe: 'Market slug or condition id' })
        .option('all', {
          type: 'boolean',
          default: false,
          describe: 'Redeem every redeemable position'
        })
    ),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleRedeem(argv as any)
};

export const activityCommand: CommandModule = {
  command: 'activity',
  describe: 'Recent account activity: trades, redemptions, transfers',
  builder: (y) =>
    walletOption(y)
      .option('limit', { type: 'number', default: 20, describe: 'Rows per page' })
      .option('cursor', { type: 'string', describe: 'nextCursor from the previous page' }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleActivity(argv as any)
};

export const pnlCommand: CommandModule = {
  command: 'pnl',
  describe: 'Portfolio value and profit and loss over an interval',
  builder: (y) =>
    walletOption(y).option('interval', {
      type: 'string',
      choices: ['1d', '1w', '1m', 'max'],
      default: '1m',
      describe: 'Interval'
    }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handlePnl(argv as any)
};

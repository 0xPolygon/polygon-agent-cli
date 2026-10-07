// watch create / cancel and alerts, through the command handlers, with a fake
// price and a session-mode wallet that covers USDC and WETH on Polygon.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Prices from '../lib/prices.ts';
import type * as Storage from '../lib/storage.ts';
import type * as Quote from '../lib/trade/quote.ts';

const fake = vi.hoisted(() => ({
  quoteSwap: undefined as undefined | ((params: unknown) => Promise<unknown>),
  priceUsd: 2500 as number | undefined,
  pointer: {
    walletAddress: '0xd384ea24ca0B3a5e4BB35935C611E3dCB68Fd08e',
    loginMethod: 'email',
    createdAt: 'x',
    access: 'session'
  } as null | { walletAddress: string; loginMethod: string; createdAt: string; access: string }
}));

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-watch-cmd-'));
const HOME = String(process.env.POLYGON_AGENT_HOME);

vi.mock('../lib/storage.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Storage>()),
  loadOmsWalletPointer: vi.fn(async () => fake.pointer)
}));
vi.mock('../lib/trade/quote.ts', async (importOriginal) => {
  const real = await importOriginal<typeof Quote>();
  return {
    ...real,
    quoteSwap: (params: Parameters<typeof real.quoteSwap>[0]) =>
      fake.quoteSwap ? fake.quoteSwap(params) : real.quoteSwap(params)
  };
});
vi.mock('../lib/prices.ts', async (importOriginal) => {
  const real = await importOriginal<typeof Prices>();
  return {
    ...real,
    getPriceReadings: vi.fn(
      async (params: { tokens: Prices.PriceQuery[] }) =>
        new Map(
          params.tokens.map((token) => [
            real.priceKey(token),
            fake.priceUsd === undefined
              ? { stale: true }
              : { usd: fake.priceUsd, updatedAt: new Date().toISOString(), stale: false }
          ])
        )
    )
  };
});

const { watchCommand, alertsCommand, quoteWatchTrade } = await import('./watch.ts');
const { loadWatches, saveWatches } = await import('../lib/watch/store.ts');
const { raiseAlert, readAlerts } = await import('../lib/watch/alerts.ts');
const { CliError } = await import('../lib/errors.ts');
const { writeApprovedPlan } = await import('../lib/session/state.ts');

async function run(args: string[]): Promise<Record<string, unknown>> {
  const yargs = (await import('yargs')).default;
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('exit');
  }) as never);
  // A synchronous handler's exit throws straight out of parseAsync.
  await Promise.resolve()
    .then(() => yargs(args).command(watchCommand).command(alertsCommand).fail(false).parseAsync())
    .catch(() => undefined);
  const line = [...log.mock.calls, ...error.mock.calls].map((call) => String(call[0]))[0];
  return JSON.parse(line ?? '{}');
}

beforeEach(() => {
  for (const file of ['watches.json', 'watch-state.json', 'alerts.jsonl']) {
    fs.rmSync(path.join(HOME, file), { force: true });
  }
  fake.priceUsd = 2500;
  fake.pointer = {
    walletAddress: '0xd384ea24ca0B3a5e4BB35935C611E3dCB68Fd08e',
    loginMethod: 'email',
    createdAt: 'x',
    access: 'session'
  };
  writeApprovedPlan({
    wallet: 'main',
    approved: {
      approvedAt: '2026-10-07T00:00:00Z',
      plan: {
        allowanceUsd: 20,
        days: 365,
        expiresAt: '2027-10-07T00:00:00Z',
        chains: [
          {
            chainId: 137,
            grants: [
              {
                symbol: 'USDC',
                token: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
                decimals: 6,
                kind: 'usd',
                limit: 20_000_000n,
                priceUsd: 1
              },
              {
                symbol: 'WETH',
                token: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
                decimals: 18,
                kind: 'eth',
                limit: 10n ** 16n,
                priceUsd: 2500
              }
            ]
          }
        ]
      }
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fake.quoteSwap = undefined;
});

describe('watch create', () => {
  it('creates an alert watch, due at the next check, with the schedule to keep', async () => {
    const out = await run([
      'watch',
      'create',
      '--token',
      'ETH',
      '--mode',
      'alert',
      '--buy-below',
      '2000'
    ]);
    expect(out).toMatchObject({
      ok: true,
      priceUsd: 2500,
      watch: { token: 'ETH', mode: 'alert', buyBelow: 2000, every: '15m' },
      schedule: { command: 'polygon-agent watch check', every: '15m' }
    });
    expect(loadWatches()).toHaveLength(1);
  });

  it('refuses a level the price has already crossed unless confirmed', async () => {
    const refused = await run([
      'watch',
      'create',
      '--token',
      'ETH',
      '--mode',
      'auto',
      '--buy-below',
      '3000',
      '--buy-amount',
      '5'
    ]);
    expect(refused).toMatchObject({ ok: false, code: 'watch_already_past', priceUsd: 2500 });
    expect(loadWatches()).toHaveLength(0);
    const confirmed = await run([
      'watch',
      'create',
      '--token',
      'ETH',
      '--mode',
      'auto',
      '--buy-below',
      '3000',
      '--buy-amount',
      '5',
      '--confirm'
    ]);
    expect(confirmed).toMatchObject({ ok: true });
    expect(loadWatches()[0]).toMatchObject({ buyArmed: true, buyAmountUsd: 5 });
  });

  it('refuses an auto watch on a token the allowance does not cover', async () => {
    const out = await run([
      'watch',
      'create',
      '--token',
      'BTC',
      '--mode',
      'auto',
      '--buy-below',
      '1000',
      '--buy-amount',
      '5'
    ]);
    expect(out).toMatchObject({ ok: false, code: 'not_covered' });
    expect(String(out.command)).toMatch(/wallet allowance set --add/);
  });

  it('lets an alert watch on an uncovered token through, with an alert suggesting the change', async () => {
    const out = await run([
      'watch',
      'create',
      '--token',
      'BTC',
      '--mode',
      'alert',
      '--buy-below',
      '1000'
    ]);
    expect(out).toMatchObject({
      ok: true,
      alerts: [expect.objectContaining({ kind: 'not_covered' })]
    });
  });

  it('checks the levels, amounts and interval', async () => {
    const cases: Array<[string[], RegExp]> = [
      [['--mode', 'alert'], /--buy-below, --sell-above/],
      [['--mode', 'alert', '--buy-below', '3000', '--sell-above', '2000'], /under --sell-above/],
      [['--mode', 'auto', '--buy-below', '2000'], /--buy-amount/],
      [['--mode', 'auto', '--sell-above', '3000'], /--sell-amount/],
      [['--mode', 'alert', '--buy-below', '2000', '--every', '1m'], /between 5m and 24h/],
      [['--mode', 'alert', '--buy-below', '2000', '--expires', '120d'], /at most 90d/]
    ];
    for (const [args, message] of cases) {
      const out = await run(['watch', 'create', '--token', 'ETH', ...args]);
      expect(out).toMatchObject({ ok: false, code: 'invalid_input' });
      expect(String(out.error)).toMatch(message);
    }
  });

  it('needs a chain for a token without a canonical one', async () => {
    const out = await run([
      'watch',
      'create',
      '--token',
      'PEPE',
      '--mode',
      'alert',
      '--buy-below',
      '1'
    ]);
    expect(out).toMatchObject({ ok: false, code: 'chain_required' });
  });

  it('refuses without a current price', async () => {
    fake.priceUsd = undefined;
    const out = await run([
      'watch',
      'create',
      '--token',
      'ETH',
      '--mode',
      'alert',
      '--buy-below',
      '2000'
    ]);
    expect(out).toMatchObject({ ok: false, code: 'upstream_unavailable' });
  });

  it('stops at 20 active watches', async () => {
    for (let i = 0; i < 20; i++) {
      await run([
        'watch',
        'create',
        '--token',
        'ETH',
        '--mode',
        'alert',
        '--buy-below',
        String(1000 + i)
      ]);
    }
    const out = await run([
      'watch',
      'create',
      '--token',
      'ETH',
      '--mode',
      'alert',
      '--buy-below',
      '999'
    ]);
    expect(out).toMatchObject({ ok: false, code: 'watch_limit_reached' });
  });
});

describe('watch cancel', () => {
  it('cancels a watch and says when the recurring check can go', async () => {
    await run(['watch', 'create', '--token', 'ETH', '--mode', 'alert', '--buy-below', '2000']);
    const id = loadWatches()[0].id;
    const out = await run(['watch', 'cancel', id]);
    expect(out).toMatchObject({ ok: true, watch: { status: 'cancelled' } });
    expect(String(out.hint)).toMatch(/can be removed/);
  });
});

describe('alerts', () => {
  it('lists unacknowledged alerts and acknowledges some or all', async () => {
    const now = new Date();
    const a = raiseAlert({ alert: { kind: 'x', message: 'one' }, now });
    raiseAlert({ alert: { kind: 'x', message: 'two' }, now });
    expect(((await run(['alerts'])).alerts as unknown[]).length).toBe(2);
    expect(await run(['alerts', '--ack', String(a?.id)])).toMatchObject({ acknowledged: [a?.id] });
    expect(((await run(['alerts'])).alerts as unknown[]).length).toBe(1);
    await run(['alerts', '--ack']);
    expect(((await run(['alerts'])).alerts as unknown[]).length).toBe(0);
    expect(((await run(['alerts', '--all'])).alerts as unknown[]).length).toBe(2);
  });
});

describe('watch create, session-mode sells', () => {
  it('an ETH watch sells the covered WETH, not native ETH', async () => {
    const out = await run([
      'watch',
      'create',
      '--token',
      'ETH',
      '--mode',
      'auto',
      '--sell-above',
      '9000',
      '--sell-amount',
      '50%'
    ]);
    expect(out).toMatchObject({ ok: true, watch: { sells: 'WETH' } });
    expect(loadWatches()[0]).toMatchObject({ token: 'ETH', sellToken: 'WETH' });
  });
});

describe('watch create, more checks', () => {
  it('records the coverage notice only once the watch exists', async () => {
    const args = ['watch', 'create', '--token', 'BTC', '--mode', 'alert', '--buy-below', '90000'];
    fake.priceUsd = 80000;
    expect(await run(args)).toMatchObject({ code: 'watch_already_past' });
    expect(readAlerts()).toEqual([]);
    expect(await run([...args, '--confirm'])).toMatchObject({
      ok: true,
      alerts: [expect.objectContaining({ kind: 'not_covered', watchId: loadWatches()[0].id })]
    });
  });

  it.each(['0', '0%', '150%', '-1', 'half'])('refuses --sell-amount %s', async (amount) => {
    const out = await run([
      'watch',
      'create',
      '--token',
      'ETH',
      '--mode',
      'auto',
      '--sell-above',
      '9000',
      '--sell-amount',
      amount
    ]);
    expect(out).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('refuses to cancel a watch twice', async () => {
    await run(['watch', 'create', '--token', 'ETH', '--mode', 'alert', '--buy-below', '2000']);
    const id = loadWatches()[0].id;
    await run(['watch', 'cancel', id]);
    expect(await run(['watch', 'cancel', id])).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('refuses to acknowledge an alert that is not open', async () => {
    expect(await run(['alerts', '--ack', 'a_nope'])).toMatchObject({
      ok: false,
      code: 'invalid_input'
    });
  });
});

describe('quoteWatchTrade', () => {
  const now = new Date();
  const base = {
    id: 'w',
    walletName: 'main',
    token: 'ETH',
    price: { chainId: 1, address: '0x0000000000000000000000000000000000000000', symbol: 'ETH' },
    mode: 'auto' as const,
    everyMs: 900_000,
    createdAt: 'x',
    expiresAt: 'x',
    nextCheckAt: 'x',
    status: 'active' as const,
    buyArmed: true,
    sellArmed: true,
    staleNotified: false
  };

  it('a sell sells the covered token on its chain (Polygon by default) for USDC', async () => {
    const calls: unknown[] = [];
    fake.quoteSwap = async (params) => {
      calls.push(params);
      return {};
    };
    await quoteWatchTrade({
      watch: { ...base, sellAbove: 3000, sellAmount: '50%', sellToken: 'WETH' },
      side: 'sell',
      now
    });
    expect(calls).toEqual([
      expect.objectContaining({ from: 'WETH', to: 'USDC', amount: '50%', chain: '137' })
    ]);
  });

  it('a buy spends --buy-amount USD, from any chain without --chain', async () => {
    const calls: Array<Record<string, unknown>> = [];
    fake.quoteSwap = async (params) => {
      calls.push(params as Record<string, unknown>);
      return {};
    };
    await quoteWatchTrade({
      watch: { ...base, buyBelow: 2000, buyAmountUsd: 5 },
      side: 'buy',
      now
    });
    expect(calls[0]).toMatchObject({ to: 'ETH', amountUsd: 5 });
    expect(calls[0]).not.toHaveProperty('chain');
    expect(calls[0]).not.toHaveProperty('from');
  });

  it('a buy on a chain pays from that chain first, then from anywhere', async () => {
    const calls: Array<Record<string, unknown>> = [];
    fake.quoteSwap = async (params) => {
      calls.push(params as Record<string, unknown>);
      if (calls.length === 1) throw new CliError({ code: 'insufficient_balance', message: 'no' });
      return {};
    };
    await quoteWatchTrade({
      watch: { ...base, chain: 8453, buyBelow: 2000, buyAmountUsd: 5 },
      side: 'buy',
      now
    });
    expect(calls[0]).toMatchObject({ chain: '8453', toChain: '8453' });
    expect(calls[1]).toMatchObject({ toChain: '8453' });
    expect(calls[1]).not.toHaveProperty('chain');
  });
});

describe('watch create, what the trade can actually do', () => {
  it('an auto sell needs USDC covered on its chain too', async () => {
    writeApprovedPlan({
      wallet: 'main',
      approved: {
        approvedAt: '2026-10-07T00:00:00Z',
        plan: {
          allowanceUsd: 20,
          days: 365,
          expiresAt: '2027-10-07T00:00:00Z',
          chains: [
            {
              chainId: 1,
              grants: [
                {
                  symbol: 'WETH',
                  token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
                  decimals: 18,
                  kind: 'eth',
                  limit: 10n ** 16n,
                  priceUsd: 2500
                }
              ]
            }
          ]
        }
      }
    });
    const out = await run([
      'watch',
      'create',
      '--token',
      'ETH',
      '--chain',
      'ethereum',
      '--mode',
      'auto',
      '--sell-above',
      '3000',
      '--sell-amount',
      '0.001'
    ]);
    expect(out).toMatchObject({ ok: false, code: 'not_covered' });
    expect(String(out.error)).toMatch(/USDC/);
  });

  it('an alert watch on a native coin the session cannot sell is still created', async () => {
    const out = await run([
      'watch',
      'create',
      '--token',
      'AVAX',
      '--chain',
      'avalanche',
      '--mode',
      'alert',
      '--sell-above',
      '3000'
    ]);
    expect(out).toMatchObject({
      ok: true,
      alerts: [expect.objectContaining({ kind: 'native_not_supported' })]
    });
  });

  it('a covered token given by its address trades as its symbol', async () => {
    const out = await run([
      'watch',
      'create',
      '--token',
      '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
      '--chain',
      'polygon',
      '--mode',
      'auto',
      '--buy-below',
      '2000',
      '--buy-amount',
      '5'
    ]);
    expect(out).toMatchObject({ ok: true });
    expect(loadWatches()[0]).toMatchObject({ token: 'WETH' });
  });

  it('owner mode: the native coin sells by amount, not by share', async () => {
    fake.pointer = {
      walletAddress: '0xd384ea24ca0B3a5e4BB35935C611E3dCB68Fd08e',
      loginMethod: 'email',
      createdAt: 'x',
      access: 'owner'
    };
    for (const amount of ['all', '50%']) {
      const out = await run([
        'watch',
        'create',
        '--token',
        'ETH',
        '--chain',
        'ethereum',
        '--mode',
        'auto',
        '--sell-above',
        '3000',
        '--sell-amount',
        amount
      ]);
      expect(out).toMatchObject({ ok: false, code: 'invalid_input' });
    }
    expect(
      await run([
        'watch',
        'create',
        '--token',
        'ETH',
        '--chain',
        'ethereum',
        '--mode',
        'auto',
        '--sell-above',
        '3000',
        '--sell-amount',
        '0.01'
      ])
    ).toMatchObject({ ok: true });
  });

  it('intervals are whole minutes, so the advised schedule is exact', async () => {
    const out = await run([
      'watch',
      'create',
      '--token',
      'ETH',
      '--mode',
      'alert',
      '--buy-below',
      '2000',
      '--every',
      '5.4m'
    ]);
    expect(out).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('cancelling the last watch keeps the check while its trade is settling', async () => {
    await run(['watch', 'create', '--token', 'ETH', '--mode', 'alert', '--buy-below', '2000']);
    const [w] = loadWatches();
    saveWatches([{ ...w, pendingTrade: { intentId: 'intent-1', side: 'buy' } }]);
    const out = await run(['watch', 'cancel', w.id]);
    expect(out).toMatchObject({
      ok: true,
      schedule: { command: 'polygon-agent watch check', pendingTrades: 1 }
    });
    expect(String(out.note)).toMatch(/still settling/);
  });
});

describe('wallet status without a connection', () => {
  it('still reports the watches, their alerts and missed checks', async () => {
    await run(['watch', 'create', '--token', 'ETH', '--mode', 'alert', '--buy-below', '2000']);
    const [w] = loadWatches();
    saveWatches([{ ...w, createdAt: new Date(Date.now() - 86_400_000).toISOString() }]);
    raiseAlert({ alert: { kind: 'watch_triggered', message: 'ETH crossed' }, now: new Date() });
    fake.pointer = null;
    const { sessionReport } = await import('./wallet-session.ts');
    const report = await sessionReport({ wallet: 'main', withVersion: false });
    expect(report).toMatchObject({
      connected: false,
      watches: {
        active: 1,
        unacknowledgedCount: 1,
        warning: expect.stringMatching(/haven't been checked/)
      }
    });
  });
});

// watch check end to end against fake prices and trades: what fires, what
// trades, what's saved, and what's alerted.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TradeRecord } from '../trade/state.ts';
import type { CheckDeps } from './check.ts';
import type { Watch } from './store.ts';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-watch-'));
const HOME = String(process.env.POLYGON_AGENT_HOME);

const { runCheck } = await import('./check.ts');
const { loadWatches, saveWatches, loadCheckState } = await import('./store.ts');
const { readAlerts, acknowledgeAlerts } = await import('./alerts.ts');
const { scheduleAdvice } = await import('./status.ts');
const { withLock } = await import('../lock.ts');
const { priceKey } = await import('../prices.ts');
const { CliError } = await import('../errors.ts');

const ETH = { chainId: 1, address: '0x0000000000000000000000000000000000000000', symbol: 'ETH' };
const T0 = new Date('2026-10-07T12:00:00Z');

function watch(overrides: Partial<Watch> = {}): Watch {
  return {
    id: 'w_1',
    walletName: 'main',
    token: 'ETH',
    price: ETH,
    mode: 'alert',
    buyBelow: 2000,
    everyMs: 15 * 60_000,
    createdAt: T0.toISOString(),
    expiresAt: new Date(T0.getTime() + 30 * 86_400_000).toISOString(),
    nextCheckAt: T0.toISOString(),
    status: 'active',
    buyArmed: true,
    sellArmed: true,
    staleNotified: false,
    ...overrides
  };
}

function trade(state: TradeRecord['state'], error?: string): TradeRecord {
  return {
    intentId: 'intent-1',
    walletName: 'main',
    walletAddress: '0xd384ea24ca0B3a5e4BB35935C611E3dCB68Fd08e',
    mode: 'session',
    state,
    origin: {
      chainId: 137,
      chain: 'polygon',
      token: '0xu',
      symbol: 'USDC',
      decimals: 6,
      amount: '1000000'
    },
    destination: {
      chainId: 137,
      chain: 'polygon',
      token: '0xw',
      symbol: 'WETH',
      decimals: 18,
      expectedAmount: '500000000000000',
      minAmount: '490000000000000'
    },
    quote: {
      fromAmountUsd: 1,
      toAmountUsd: 1,
      totalFeeUsd: 0.01,
      priceImpact: 0,
      slippage: 0.005,
      routeProviders: [],
      intentExpiresAt: T0.toISOString()
    },
    expiresAt: T0.toISOString(),
    deposit: { to: '0xd', data: '0x', value: '0' },
    ...(error ? { error } : {}),
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString()
  };
}

let clock = T0;
let price: number | undefined = 1900;
let stale = false;
// What the saved trade file says (deps.loadTrade).
let saved: TradeRecord | null = null;

function deps(overrides: Partial<CheckDeps> = {}) {
  const base = {
    now: () => clock,
    prices: vi.fn(
      async () =>
        new Map([
          [
            priceKey(ETH),
            {
              ...(price !== undefined ? { usd: price } : {}),
              updatedAt: clock.toISOString(),
              stale
            }
          ]
        ])
    ),
    quote: vi.fn(async () => ({ trade: trade('quoted'), highFee: false, warnings: [] })),
    execute: vi.fn(async () => trade('completed')),
    resumeTrade: vi.fn(async (): Promise<TradeRecord | null> => trade('completed')),
    loadTrade: vi.fn(() => saved),
    walletName: 'main'
  };
  return { ...base, ...overrides } satisfies CheckDeps;
}

const kinds = () => readAlerts().map((alert) => alert.kind);

beforeEach(() => {
  for (const file of ['watches.json', 'watch-state.json', 'alerts.jsonl']) {
    fs.rmSync(path.join(HOME, file), { force: true });
  }
  clock = T0;
  price = 1900;
  stale = false;
  saved = null;
});

describe('watch check', () => {
  it('makes no price call when nothing is due', async () => {
    saveWatches([watch({ nextCheckAt: new Date(T0.getTime() + 60_000).toISOString() })]);
    const d = deps();
    const result = await runCheck(d);
    expect(d.prices).not.toHaveBeenCalled();
    expect(result).toMatchObject({ due: 0, alerts: [] });
    expect(loadCheckState().lastCheckAt).toBe(T0.toISOString());
  });

  it('reads all due watches in one price call', async () => {
    saveWatches([watch({ id: 'w_1' }), watch({ id: 'w_2', buyBelow: 1000 })]);
    const d = deps();
    await runCheck(d);
    expect(d.prices).toHaveBeenCalledTimes(1);
  });

  it('an alert watch raises the crossing with the swap to quote, and schedules the next check', async () => {
    saveWatches([watch({ buyAmountUsd: 50 })]);
    const result = await runCheck(deps());
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toMatchObject({
      kind: 'watch_triggered',
      watchId: 'w_1',
      command: 'polygon-agent swap --to ETH --amount-usd 50 --dry-run'
    });
    expect(result.alerts[0].message).toMatch(/\$1,900, at or below the \$2,000 buy level/);
    const [stored] = loadWatches();
    expect(stored).toMatchObject({ buyArmed: false, lastPrice: 1900 });
    expect(stored.nextCheckAt).toBe(new Date(T0.getTime() + 15 * 60_000).toISOString());
  });

  it('an auto watch trades once per arming, saving the disarmed state and the pending trade first', async () => {
    saveWatches([watch({ mode: 'auto', buyAmountUsd: 1 })]);
    let duringExecute: Watch | undefined;
    const d = deps({
      execute: vi.fn(async () => {
        duringExecute = loadWatches()[0];
        return trade('completed');
      })
    });
    const result = await runCheck(d);
    expect(d.quote).toHaveBeenCalledWith(expect.objectContaining({ side: 'buy' }));
    // Killed here, the next check would follow the trade up and not fire again.
    expect(duringExecute).toMatchObject({
      buyArmed: false,
      pendingTrade: { intentId: 'intent-1', side: 'buy' }
    });
    expect(result.alerts.map((a) => a.kind)).toEqual(['auto_trade_completed']);
    expect(loadWatches()[0].pendingTrade).toBeUndefined();

    // Still below at the next check: no second trade.
    clock = new Date(T0.getTime() + 16 * 60_000);
    await runCheck(d);
    expect(d.quote).toHaveBeenCalledTimes(1);
  });

  it('a quote that fails disarms the level, and the alert gives the reason and fix', async () => {
    saveWatches([watch({ mode: 'auto', buyAmountUsd: 1 })]);
    const d = deps({
      quote: vi.fn(async () => {
        throw new CliError({
          code: 'not_covered',
          message: "WETH on Polygon isn't covered by the allowance.",
          command: 'polygon-agent wallet allowance set --add WETH@polygon'
        });
      })
    });
    const result = await runCheck(d);
    expect(result.alerts[0]).toMatchObject({
      kind: 'auto_trade_failed',
      command: 'polygon-agent wallet allowance set --add WETH@polygon'
    });
    expect(result.alerts[0].message).toMatch(/didn't run: WETH on Polygon/);
    expect(loadWatches()[0].buyArmed).toBe(false);
  });

  it('a passing failure to quote keeps the level armed for the next check', async () => {
    saveWatches([watch({ mode: 'auto', buyAmountUsd: 1 })]);
    const d = deps({
      quote: vi.fn(async () => {
        throw new CliError({ code: 'rate_limited', message: 'slow down' });
      })
    });
    const result = await runCheck(d);
    expect(result.alerts).toEqual([]);
    expect(result.warnings?.[0]).toMatch(/retrying at the next check/);
    expect(loadWatches()[0].buyArmed).toBe(true);
  });

  it("doesn't execute a quote whose fees are over 10%", async () => {
    saveWatches([watch({ mode: 'auto', buyAmountUsd: 1 })]);
    const d = deps({
      quote: vi.fn(async () => ({
        trade: trade('quoted'),
        highFee: true,
        warnings: ['Fees are $0.15, 15% of the $1.00 being traded.']
      }))
    });
    const result = await runCheck(d);
    expect(d.execute).not.toHaveBeenCalled();
    expect(result.alerts[0]).toMatchObject({ kind: 'auto_trade_failed' });
    expect(result.alerts[0].message).toMatch(/wasn't executed: Fees are \$0.15, 15%/);
  });

  it('an error after the deposit went out keeps following the trade, and never says it did not run', async () => {
    saveWatches([watch({ mode: 'auto', buyAmountUsd: 1 })]);
    saved = trade('depositing');
    const d = deps({
      execute: vi.fn(async () => {
        throw new CliError({
          code: 'upstream_unavailable',
          message: "The deposit isn't confirmed yet"
        });
      }),
      resumeTrade: vi.fn(async () => trade('completed'))
    });
    const first = await runCheck(d);
    expect(first.alerts.map((a) => a.kind)).toEqual(['auto_trade_executing']);
    expect(first.alerts[0].message).toMatch(/may have gone out/);
    expect(loadWatches()[0].pendingTrade).toEqual({ intentId: 'intent-1', side: 'buy' });

    clock = new Date(T0.getTime() + 60_000);
    const second = await runCheck(d);
    expect(second.alerts.map((a) => a.kind)).toEqual(['auto_trade_completed']);
    expect(loadWatches()[0].pendingTrade).toBeUndefined();
  });

  it('an error before anything was sent says so and ends the trade', async () => {
    saveWatches([watch({ mode: 'auto', buyAmountUsd: 1 })]);
    saved = trade('quoted', 'allowance used up');
    const d = deps({
      execute: vi.fn(async () => {
        throw new CliError({
          code: 'allowance_exhausted',
          message: 'The allowance is used up.',
          command: 'polygon-agent wallet allowance set'
        });
      })
    });
    const result = await runCheck(d);
    expect(result.alerts[0]).toMatchObject({
      kind: 'auto_trade_failed',
      command: 'polygon-agent wallet allowance set'
    });
    expect(result.alerts[0].message).toMatch(
      /didn't run \(nothing was sent\): The allowance is used up/
    );
    expect(loadWatches()[0].pendingTrade).toBeUndefined();
  });

  it('follows up a trade Trails was still working on, then reports how it ended', async () => {
    saveWatches([watch({ mode: 'auto', buyAmountUsd: 1 })]);
    const d = deps({ execute: vi.fn(async () => trade('executing')) });
    const first = await runCheck(d);
    expect(first.alerts.map((a) => a.kind)).toEqual(['auto_trade_executing']);
    expect(loadWatches()[0].pendingTrade).toEqual({ intentId: 'intent-1', side: 'buy' });

    clock = new Date(T0.getTime() + 60_000);
    const second = await runCheck(d);
    expect(d.resumeTrade).toHaveBeenCalledWith('intent-1');
    expect(second.alerts.map((a) => a.kind)).toEqual(['auto_trade_completed']);
    expect(loadWatches()[0].pendingTrade).toBeUndefined();
  });

  it('a pending quote a stopped check never sent is reported and ended', async () => {
    saveWatches([
      watch({
        mode: 'auto',
        buyArmed: false,
        nextCheckAt: new Date(T0.getTime() + 60_000).toISOString(),
        pendingTrade: { intentId: 'intent-1', side: 'buy' }
      })
    ]);
    const result = await runCheck(deps({ resumeTrade: vi.fn(async () => trade('quoted')) }));
    expect(result.alerts.map((a) => a.kind)).toEqual(['auto_trade_failed']);
    expect(loadWatches()[0].pendingTrade).toBeUndefined();
  });

  it('a pending trade whose record is gone is reported, not dropped silently', async () => {
    saveWatches([
      watch({
        nextCheckAt: new Date(T0.getTime() + 60_000).toISOString(),
        pendingTrade: { intentId: 'intent-1', side: 'buy' }
      })
    ]);
    const result = await runCheck(deps({ resumeTrade: vi.fn(async () => null) }));
    expect(result.alerts.map((a) => a.kind)).toEqual(['auto_trade_unknown']);
  });

  it('a stale price never fires and alerts once per stale stretch', async () => {
    saveWatches([watch()]);
    stale = true;
    const d = deps();
    expect((await runCheck(d)).alerts.map((a) => a.kind)).toEqual(['price_stale']);
    clock = new Date(T0.getTime() + 16 * 60_000);
    expect((await runCheck(d)).alerts).toEqual([]);
    expect(loadWatches()[0].buyArmed).toBe(true);
  });

  it('a failed price read counts as stale', async () => {
    saveWatches([watch()]);
    const result = await runCheck(
      deps({
        prices: vi.fn(async () => {
          throw new Error('Trails down');
        })
      })
    );
    expect(result.alerts.map((a) => a.kind)).toEqual(['price_stale']);
    expect(result.warnings?.[0]).toMatch(/Trails down/);
  });

  it('re-arms after a 2% move back and trades again', async () => {
    saveWatches([watch({ mode: 'auto', buyAmountUsd: 1 })]);
    const d = deps();
    await runCheck(d);
    for (const [minutes, p] of [
      [16, 2041],
      [32, 1990]
    ]) {
      clock = new Date(T0.getTime() + minutes * 60_000);
      price = p;
      await runCheck(d);
    }
    expect(d.quote).toHaveBeenCalledTimes(2);
  });

  it('expires old watches without checking them, and later drops them', async () => {
    saveWatches([watch({ expiresAt: T0.toISOString() })]);
    const d = deps();
    const result = await runCheck(d);
    expect(result.alerts.map((a) => a.kind)).toEqual(['watch_expired']);
    expect(d.prices).not.toHaveBeenCalled();
    expect(loadWatches()[0].status).toBe('expired');
    clock = new Date(T0.getTime() + 31 * 86_400_000);
    await runCheck(d);
    expect(loadWatches()).toEqual([]);
  });

  it('is skipped while another check holds the lock', async () => {
    saveWatches([watch()]);
    const d = deps();
    const result = await withLock({
      dir: path.join(HOME, 'locks', 'watch.lock'),
      fn: () => runCheck(d)
    });
    expect(result).toMatchObject({ skipped: true });
    expect(d.prices).not.toHaveBeenCalled();
  });

  it('runs the allowance checks hourly per wallet, and raises each one once', async () => {
    const sessionAlerts = vi.fn(async (wallet: string) => [
      {
        kind: 'allowance_low',
        message: `$1 left (${wallet})`,
        key: `session:${wallet}:a:allowance_low`
      }
    ]);
    saveWatches([watch({ walletName: 'other', buyBelow: 100 })]);
    const d = deps({ sessionAlerts });
    expect((await runCheck(d)).alerts.map((a) => a.message)).toEqual([
      '$1 left (main)',
      '$1 left (other)'
    ]);
    clock = new Date(T0.getTime() + 30 * 60_000);
    await runCheck(d);
    expect(sessionAlerts).toHaveBeenCalledTimes(2);

    // An hour later they're checked again, but not raised again, even once acknowledged.
    acknowledgeAlerts({ now: clock });
    clock = new Date(T0.getTime() + 61 * 60_000);
    expect((await runCheck(d)).alerts).toEqual([]);
    expect(sessionAlerts).toHaveBeenCalledTimes(4);
    expect(kinds()).toEqual(['allowance_low', 'allowance_low']);
  });

  it('never runs a second auto trade while an earlier one may be in flight', async () => {
    saveWatches([
      watch({ mode: 'auto', buyAmountUsd: 1, pendingTrade: { intentId: 'intent-1', side: 'buy' } })
    ]);
    const d = deps({ resumeTrade: vi.fn(async () => trade('depositing')) });
    const result = await runCheck(d);
    expect(d.quote).not.toHaveBeenCalled();
    expect(result.alerts.map((a) => a.kind)).toEqual(['auto_trade_skipped']);
    expect(loadWatches()[0].pendingTrade).toEqual({ intentId: 'intent-1', side: 'buy' });
  });

  it('an owner-mode deposit with an unclear outcome is reported once, not followed forever', async () => {
    saveWatches([watch({ mode: 'auto', buyAmountUsd: 1 })]);
    saved = { ...trade('depositing'), mode: 'owner' };
    const d = deps({
      execute: vi.fn(async () => {
        throw new CliError({ code: 'upstream_error', message: 'unclear' });
      })
    });
    const result = await runCheck(d);
    expect(result.alerts.map((a) => a.kind)).toEqual(['auto_trade_unknown']);
    expect(result.alerts[0].message).toMatch(/Check the wallet's activity/);
    expect(loadWatches()[0].pendingTrade).toBeUndefined();
  });

  it('an owner-mode pending trade left unclear by an earlier run is settled the same way', async () => {
    saveWatches([
      watch({
        nextCheckAt: new Date(T0.getTime() + 60_000).toISOString(),
        pendingTrade: { intentId: 'intent-1', side: 'buy' }
      })
    ]);
    saved = { ...trade('depositing'), mode: 'owner' };
    const d = deps();
    const result = await runCheck(d);
    expect(d.resumeTrade).not.toHaveBeenCalled();
    expect(result.alerts.map((a) => a.kind)).toEqual(['auto_trade_unknown']);
  });

  it('a busy wallet at execute time keeps the level armed: nothing was sent', async () => {
    saveWatches([watch({ mode: 'auto', buyAmountUsd: 1 })]);
    saved = trade('quoted', 'busy');
    const d = deps({
      execute: vi.fn(async () => {
        throw new CliError({
          code: 'wallet_busy',
          message: 'Another command is using the wallet.'
        });
      })
    });
    const result = await runCheck(d);
    expect(result.alerts).toEqual([]);
    expect(result.warnings?.[0]).toMatch(/wasn't sent .* retrying/);
    expect(loadWatches()[0]).toMatchObject({ buyArmed: true });
    expect(loadWatches()[0].pendingTrade).toBeUndefined();
  });

  it('re-reads a price that aged while earlier watches traded, before acting on it', async () => {
    saveWatches([
      watch({ id: 'w_1', mode: 'auto', buyAmountUsd: 1 }),
      watch({ id: 'w_2', mode: 'auto', buyAmountUsd: 1 })
    ]);
    const d = deps({
      // Each trade takes 6 minutes.
      execute: vi.fn(async () => {
        clock = new Date(clock.getTime() + 6 * 60_000);
        return trade('completed');
      })
    });
    await runCheck(d);
    // The batch, then a fresh read for w_2 once its reading was 6 minutes old.
    expect(d.prices).toHaveBeenCalledTimes(2);
    expect(d.quote).toHaveBeenCalledTimes(2);
  });

  it("doesn't act on an aged price it can't re-read, and keeps the level armed", async () => {
    saveWatches([
      watch({ id: 'w_1', mode: 'auto', buyAmountUsd: 1 }),
      watch({ id: 'w_2', mode: 'auto', buyAmountUsd: 1 })
    ]);
    let calls = 0;
    const d = deps({
      prices: vi.fn(async () => {
        if (++calls > 1) throw new Error('Trails down');
        return new Map([
          [priceKey(ETH), { usd: 1900, updatedAt: clock.toISOString(), stale: false }]
        ]);
      }),
      execute: vi.fn(async () => {
        clock = new Date(clock.getTime() + 6 * 60_000);
        return trade('completed');
      })
    });
    await runCheck(d);
    expect(d.quote).toHaveBeenCalledTimes(1);
    expect(loadWatches().find((w) => w.id === 'w_2')?.buyArmed).toBe(true);
  });

  it('a watch that expires while an earlier one trades is expired, not traded', async () => {
    saveWatches([
      watch({ id: 'w_1', mode: 'auto', buyAmountUsd: 1 }),
      watch({
        id: 'w_2',
        mode: 'auto',
        buyAmountUsd: 1,
        expiresAt: new Date(T0.getTime() + 30_000).toISOString()
      })
    ]);
    const d = deps({
      execute: vi.fn(async () => {
        clock = new Date(clock.getTime() + 60_000);
        return trade('completed');
      })
    });
    const result = await runCheck(d);
    expect(d.quote).toHaveBeenCalledTimes(1);
    expect(loadWatches().find((w) => w.id === 'w_2')?.status).toBe('expired');
    expect(result.alerts.map((a) => a.kind)).toContain('watch_expired');
  });

  it('no deposit after the watch expires or its price goes stale, whichever is first', async () => {
    const expiresAt = new Date(T0.getTime() + 60_000);
    saveWatches([watch({ mode: 'auto', buyAmountUsd: 1, expiresAt: expiresAt.toISOString() })]);
    const d = deps();
    await runCheck(d);
    expect(d.execute).toHaveBeenCalledWith(
      expect.objectContaining({ notAfter: expiresAt.getTime() })
    );

    fs.rmSync(path.join(HOME, 'watches.json'), { force: true });
    saveWatches([watch({ mode: 'auto', buyAmountUsd: 1 })]);
    const d2 = deps();
    await runCheck(d2);
    expect(d2.execute).toHaveBeenCalledWith(
      expect.objectContaining({ notAfter: T0.getTime() + 5 * 60_000 })
    );
  });

  it('a deadline passing before the deposit keeps the level armed: nothing was sent', async () => {
    saveWatches([watch({ mode: 'auto', buyAmountUsd: 1 })]);
    saved = trade('quoted');
    const d = deps({
      execute: vi.fn(async () => {
        throw new CliError({
          code: 'quote_expired',
          message: 'The deadline passed; nothing was sent.'
        });
      })
    });
    const result = await runCheck(d);
    expect(result.alerts).toEqual([]);
    expect(loadWatches()[0]).toMatchObject({ buyArmed: true });
  });

  it("an alert that can't be written isn't lost: the next check delivers it", async () => {
    saveWatches([watch()]);
    const append = vi.spyOn(fs, 'appendFileSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });
    await expect(runCheck(deps())).rejects.toThrow('ENOSPC');
    append.mockRestore();
    // The crossing is consumed, but its alert is owed.
    expect(loadWatches()[0]).toMatchObject({ buyArmed: false });
    expect(loadWatches()[0].outbox).toHaveLength(1);

    clock = new Date(T0.getTime() + 60_000);
    const result = await runCheck(deps());
    expect(result.alerts.map((a) => a.kind)).toEqual(['watch_triggered']);
    expect(loadWatches()[0].outbox).toBeUndefined();
    // Delivered once, however often it's retried.
    await runCheck(deps());
    expect(kinds()).toEqual(['watch_triggered']);
  });

  it('a cancelled watch whose outcome alert is still owed keeps the recurring check', async () => {
    saveWatches([
      watch({
        mode: 'auto',
        status: 'cancelled',
        buyArmed: false,
        pendingTrade: { intentId: 'intent-1', side: 'buy' }
      })
    ]);
    const append = vi.spyOn(fs, 'appendFileSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });
    await expect(runCheck(deps())).rejects.toThrow('ENOSPC');
    append.mockRestore();
    // The trade is settled, but its completion alert is owed.
    expect(loadWatches()[0].pendingTrade).toBeUndefined();
    expect(scheduleAdvice(loadWatches())).toMatchObject({ undeliveredAlerts: 1 });

    clock = new Date(T0.getTime() + 60_000);
    const result = await runCheck(deps());
    expect(result.alerts.map((a) => a.kind)).toEqual(['auto_trade_completed']);
    expect(scheduleAdvice(loadWatches())).toBeUndefined();
  });
});

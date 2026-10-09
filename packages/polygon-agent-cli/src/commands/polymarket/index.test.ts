import { describe, expect, it, vi } from 'vitest';

const { polymarketCommand } = await import('./index.ts');
const yargs = (await import('yargs')).default;

async function help(args: string[]): Promise<string> {
  return new Promise<string>((resolve) => {
    void yargs()
      .command(polymarketCommand)
      .exitProcess(false)
      .parse(args, (_e: unknown, _a: unknown, out: string) => resolve(out));
  });
}

describe('polymarketCommand', () => {
  it('lists the new commands and hides the old names', async () => {
    const out = await help(['polymarket', '--help']);
    for (const name of [
      'setup',
      'status',
      'import-key',
      'recover',
      'deposit',
      'withdraw',
      'markets',
      'event',
      'market',
      'book',
      'history',
      'buy',
      'sell',
      'orders',
      'cancel',
      'positions',
      'redeem',
      'activity',
      'pnl'
    ]) {
      expect(out).toContain(name);
    }
    for (const hidden of ['clob-buy', 'proxy-wallet', 'set-key', ' approve']) {
      expect(out).not.toContain(hidden);
    }
  });

  it('keeps the old names callable and maps clob-buy amount to the buy usd argument', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      await yargs()
        .command(polymarketCommand)
        .exitProcess(false)
        .parseAsync(['polymarket', 'clob-buy', 'x', 'yes', '0.1234567', '--dry-run']);
      // 7 decimals is rejected by the buy handler, which proves the amount reached `usd`
      const printed = [...spy.mock.calls, ...errSpy.mock.calls].map((c) => String(c[0])).join('\n');
      expect(printed).toContain('invalid_input');
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
      exit.mockRestore();
    }
  });
});

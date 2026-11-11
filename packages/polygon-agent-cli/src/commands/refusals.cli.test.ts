import fs from 'node:fs';

import { afterAll, describe, expect, it } from 'vitest';

import {
  cleanupHarness,
  makeHome,
  resetTripwire,
  runCli,
  tripwireHits
} from '../test-harness/cli.ts';

afterAll(cleanupHarness);

// Polygon USDC, as in the CLI's own token table.
const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

function filesUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

describe('parser discipline', { timeout: 30_000 }, () => {
  const cases: Array<{ name: string; args: string[]; usage: string }> = [
    { name: 'an unknown flag', args: ['mode', '--bogus'], usage: 'Unknown argument' },
    { name: 'no command', args: [], usage: 'Commands:' },
    {
      name: 'a missing required option',
      args: ['send-token', '--to', USDC],
      usage: 'Missing required argument'
    }
  ];

  for (const { name, args, usage } of cases) {
    it(`exits 1 with usage on stderr and nothing on stdout for ${name}`, async () => {
      resetTripwire();
      const result = await runCli({ args });
      expect(result.exitCode).equal(1);
      expect(result.stdout).equal('');
      expect(result.stderr).contain(usage);
      expect(tripwireHits()).deep.equal([]);
    });
  }
});

// Each handler checks the wallet before any upstream call, so with no wallet
// connected it refuses offline and leaves the state folder empty.
describe('money commands refuse with no wallet connected', { timeout: 30_000 }, () => {
  const walletMissing = { error: 'Wallet not found: main' };
  const rows: Array<{ command: string[]; failure: Record<string, string> }> = [
    {
      command: ['send-token', '--symbol', 'USDC', '--to', USDC, '--amount', '1', '--broadcast'],
      failure: walletMissing
    },
    {
      command: ['send-native', '--to', USDC, '--amount', '1', '--broadcast'],
      failure: walletMissing
    },
    { command: ['send', '--to', USDC, '--amount', '1', '--broadcast'], failure: walletMissing },
    { command: ['call', '--to', USDC, '--data', '0x', '--broadcast'], failure: walletMissing },
    { command: ['deposit', '--amount', '1', '--broadcast'], failure: walletMissing },
    {
      command: ['withdraw', '--position', USDC, '--amount', '1', '--broadcast'],
      failure: walletMissing
    },
    {
      command: ['swap', '--from', 'USDC', '--to', 'USDT', '--amount', '1', '--broadcast'],
      failure: { code: 'not_connected' }
    },
    {
      command: ['wallet', 'withdraw', '--to', USDC, '--token', 'USDC', '--amount', '1'],
      failure: { code: 'not_connected' }
    },
    { command: ['polymarket', 'deposit', '5'], failure: { code: 'not_set_up' } },
    { command: ['polymarket', 'withdraw', '5'], failure: { code: 'not_set_up' } },
    { command: ['polymarket', 'buy', 'some-market', 'yes', '5'], failure: { code: 'not_set_up' } },
    { command: ['polymarket', 'sell', 'some-market', 'yes', '5'], failure: { code: 'not_set_up' } }
  ];

  for (const { command, failure } of rows) {
    it(`${command.slice(0, command[0] === 'wallet' || command[0] === 'polymarket' ? 2 : 1).join(' ')} exits 1 with failure JSON on stderr`, async () => {
      resetTripwire();
      const home = makeHome();
      const result = await runCli({ args: command, home });
      expect(result.exitCode).equal(1);
      expect(result.stdout).equal('');
      expect(result.stderrJson).property('ok').equal(false);
      if (failure.code) expect(result.stderrJson).property('code').equal(failure.code);
      if (failure.error) expect(result.stderrJson).property('error').contain(failure.error);
      expect(filesUnder(home)).deep.equal([]);
      expect(tripwireHits()).deep.equal([]);
    });
  }
});

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  cleanupHarness,
  makeHome,
  resetTripwire,
  runCli,
  tripwireHits
} from '../test-harness/cli.ts';

afterAll(cleanupHarness);

// Shape follows WatchSchema in lib/watch/store.ts; values are throwaway.
function seedWatch(id: string): Record<string, unknown> {
  const now = Date.now();
  return {
    id,
    walletName: 'main',
    token: 'ETH',
    price: { chainId: 1, address: `0x${randomBytes(20).toString('hex')}`, symbol: 'ETH' },
    mode: 'alert',
    buyBelow: 1,
    everyMs: 15 * 60_000,
    createdAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 86_400_000).toISOString(),
    nextCheckAt: new Date(now + 900_000).toISOString(),
    status: 'active',
    buyArmed: true,
    sellArmed: true,
    staleNotified: false
  };
}

function seedWatches(home: string, ids: string[]): string {
  const file = path.join(home, 'watches.json');
  fs.writeFileSync(file, JSON.stringify({ watches: ids.map(seedWatch) }));
  return file;
}

function statuses(file: string): Record<string, string> {
  const parsed: { watches: Array<{ id: string; status: string }> } = JSON.parse(
    fs.readFileSync(file, 'utf8')
  );
  return Object.fromEntries(parsed.watches.map((w) => [w.id, w.status]));
}

describe('watch cancel', { timeout: 30_000 }, () => {
  it('cancels only the named watch on disk', async () => {
    resetTripwire();
    const home = makeHome();
    const file = seedWatches(home, ['w_aaaa0001', 'w_aaaa0002']);

    const result = await runCli({ args: ['watch', 'cancel', 'w_aaaa0001'], home });
    expect(result.exitCode).equal(0);
    expect(result.stdoutJson).property('ok').equal(true);
    expect(statuses(file)).deep.equal({ w_aaaa0001: 'cancelled', w_aaaa0002: 'active' });
    expect(tripwireHits()).deep.equal([]);
  });

  it('exits 1 for an unknown id and leaves the file byte-identical', async () => {
    resetTripwire();
    const home = makeHome();
    const file = seedWatches(home, ['w_aaaa0001']);
    const before = fs.readFileSync(file);

    const result = await runCli({ args: ['watch', 'cancel', 'w_nope'], home });
    expect(result.exitCode).equal(1);
    expect(result.stderrJson).property('ok').equal(false);
    expect(fs.readFileSync(file).equals(before)).equal(true);
    expect(tripwireHits()).deep.equal([]);
  });
});

describe('alerts --ack', { timeout: 30_000 }, () => {
  it('marks the alert acknowledged in the log', async () => {
    resetTripwire();
    const home = makeHome();
    const ts = new Date(Date.now() - 60_000).toISOString();
    const file = path.join(home, 'alerts.jsonl');
    fs.writeFileSync(
      file,
      [
        { id: 'a_0000000001', ts, kind: 'price', message: 'one' },
        { id: 'a_0000000002', ts, kind: 'price', message: 'two' }
      ]
        .map((a) => JSON.stringify(a))
        .join('\n') + '\n'
    );

    const acked = await runCli({ args: ['alerts', '--ack', 'a_0000000001'], home });
    expect(acked.exitCode).equal(0);
    expect(acked.stdoutJson).deep.equal({ ok: true, acknowledged: ['a_0000000001'] });
    const lines = fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l): Record<string, unknown> => JSON.parse(l));
    expect(lines.filter((l) => 'ack' in l).map((l) => l.ack)).deep.equal(['a_0000000001']);

    const open = await runCli({ args: ['alerts'], home });
    expect(open.stdoutJson).property('alerts').a('array').lengthOf(1);
    expect(tripwireHits()).deep.equal([]);
  });
});

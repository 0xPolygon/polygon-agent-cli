import fs from 'node:fs';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  cleanupHarness,
  makeHome,
  resetTripwire,
  runCli,
  runNode,
  tripwireHits
} from '../test-harness/cli.ts';

afterAll(cleanupHarness);

describe('network tripwire', { timeout: 30_000 }, () => {
  it('records and refuses an outbound request, so zero-hit assertions mean something', async () => {
    resetTripwire();
    const result = await runNode({
      nodeArgs: ['-e', "fetch('https://example.com/').catch(() => {})"]
    });
    expect(result.exitCode).equal(0);
    expect(tripwireHits()).deep.equal(['CONNECT example.com:443']);
  });
});

describe('agent mode', { timeout: 30_000 }, () => {
  it('defaults to dry-run on fresh state and writes nothing', async () => {
    resetTripwire();
    const home = makeHome();
    const result = await runCli({ args: ['mode'], home });
    expect(result.exitCode).equal(0);
    expect(result.stdoutJson).deep.equal({ ok: true, mode: 'dry-run', source: 'default' });
    expect(fs.existsSync(path.join(home, 'config.json'))).equal(false);
    expect(tripwireHits()).deep.equal([]);
  });

  it('persists auto, warns, and round-trips back to dry-run', async () => {
    resetTripwire();
    const home = makeHome();
    const configPath = path.join(home, 'config.json');

    const auto = await runCli({ args: ['mode', 'auto'], home });
    expect(auto.exitCode).equal(0);
    expect(auto.stdoutJson).property('saved').equal(true);
    expect(auto.stdoutJson).property('warning').a('string');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')))
      .property('mode')
      .equal('auto');

    const shown = await runCli({ args: ['mode'], home });
    expect(shown.stdoutJson).deep.equal({ ok: true, mode: 'auto', source: 'saved' });

    const back = await runCli({ args: ['mode', 'dry-run'], home });
    expect(back.exitCode).equal(0);
    expect(back.stdoutJson).deep.equal({ ok: true, mode: 'dry-run', saved: true });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')))
      .property('mode')
      .equal('dry-run');
    expect(tripwireHits()).deep.equal([]);
  });

  it('rejects an invalid mode with usage on stderr, nothing on stdout, and no saved state', async () => {
    resetTripwire();
    const home = makeHome();
    const result = await runCli({ args: ['mode', 'bogus'], home });
    expect(result.exitCode).equal(1);
    expect(result.stdout).equal('');
    expect(result.stderr).contain('Invalid values');
    expect(result.stderr).contain('mode');
    expect(fs.existsSync(path.join(home, 'config.json'))).equal(false);
    expect(tripwireHits()).deep.equal([]);
  });
});

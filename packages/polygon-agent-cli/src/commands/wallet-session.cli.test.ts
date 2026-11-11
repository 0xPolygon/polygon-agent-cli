import { spawnSync } from 'node:child_process';
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

describe('wallet login --wait', { timeout: 30_000 }, () => {
  it('exits 1 with request_expired when no sign-in is pending', async () => {
    resetTripwire();
    const home = makeHome();
    const result = await runCli({ args: ['wallet', 'login', '--wait'], home });
    expect(result.exitCode).equal(1);
    expect(result.stdout).equal('');
    expect(result.stderrJson).property('code').equal('request_expired');
    expect(tripwireHits()).deep.equal([]);
  });

  it('reports browser_signin_failed for a dead waiter and removes its pid file', async () => {
    resetTripwire();
    const home = makeHome();
    // A pid that belonged to a process which has already exited.
    const dead = spawnSync(process.execPath, ['-e', '']);
    const pid = dead.pid;
    const dir = path.join(home, 'pending', 'main');
    const pidFile = path.join(dir, 'waiter-req1.pid');
    const emailCommand = 'polygon-agent wallet confirm --request req1 --code <code>';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(pidFile, JSON.stringify({ pid, emailCommand }));

    const result = await runCli({ args: ['wallet', 'login', '--wait'], home });
    expect(result.exitCode).equal(1);
    expect(result.stderrJson).property('code').equal('browser_signin_failed');
    expect(result.stderrJson).property('command').equal(emailCommand);
    expect(fs.existsSync(pidFile)).equal(false);
    expect(tripwireHits()).deep.equal([]);
  });
});

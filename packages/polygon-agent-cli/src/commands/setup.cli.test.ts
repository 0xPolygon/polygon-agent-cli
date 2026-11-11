import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FakeBuilder } from '../test-harness/fake-builder.ts';

import {
  cleanupHarness,
  makeHome,
  resetTripwire,
  runCli,
  tripwireHits
} from '../test-harness/cli.ts';
import { startFakeBuilder } from '../test-harness/fake-builder.ts';

let builder!: FakeBuilder;

beforeAll(async () => {
  builder = await startFakeBuilder();
});

afterAll(async () => {
  await builder.close();
  await cleanupHarness();
});

describe('agent setup', { timeout: 30_000 }, () => {
  it('provisions through the Builder API and stores the config owner-only and encrypted', async () => {
    resetTripwire();
    builder.requests.length = 0;
    const home = makeHome();
    const result = await runCli({
      args: ['setup', '--name', 'test-project'],
      env: { SEQUENCE_BUILDER_API_URL: builder.url },
      home
    });

    expect(result.exitCode).equal(0);
    expect(result.stdoutJson).property('ok').equal(true);
    expect(result.stdoutJson)
      .property('eoaAddress')
      .match(/^0x[0-9a-fA-F]{40}$/);
    expect(result.stdoutJson).property('accessKey').equal('ak-test');
    expect(result.stdoutJson).property('projectId').equal(7);
    expect(result.stdoutJson).property('projectName').equal('fake-project');

    expect(builder.requests.map((r) => r.path)).deep.equal([
      '/rpc/Builder/GetAuthToken',
      '/rpc/Builder/CreateProject',
      '/rpc/QuotaControl/GetDefaultAccessKey'
    ]);
    const [auth, create, accessKey] = builder.requests;
    expect(auth?.body).property('ethauthProof').a('string');
    expect(auth?.authorization).equal(undefined);
    expect(create?.authorization).equal('Bearer jwt-test');
    expect(create?.body).deep.equal({ name: 'test-project' });
    expect(accessKey?.authorization).equal('Bearer jwt-test');
    expect(accessKey?.body).deep.equal({ projectID: 7 });

    const configPath = path.join(home, 'builder.json');
    expect(fs.statSync(configPath).mode & 0o777).equal(0o600);
    const stored = fs.readFileSync(configPath, 'utf8');
    expect(stored).not.match(/0x[0-9a-fA-F]{64}/);
    expect(JSON.parse(stored)).property('privateKey').property('encrypted').a('string');
    expect(tripwireHits()).deep.equal([]);
  });

  it('is a no-op when already configured and --force is not given', async () => {
    resetTripwire();
    const home = makeHome();
    const env = { SEQUENCE_BUILDER_API_URL: builder.url };
    await runCli({ args: ['setup'], env, home });
    builder.requests.length = 0;

    const again = await runCli({ args: ['setup'], env, home });
    expect(again.exitCode).equal(0);
    expect(again.stdoutJson).property('message').contain('already configured');
    expect(again.stdoutJson).property('accessKey').equal('ak-test');
    expect(builder.requests).deep.equal([]);
    expect(tripwireHits()).deep.equal([]);
  });

  it('fails with the failure JSON on stderr and stores nothing when project creation fails', async () => {
    resetTripwire();
    const failing = await startFakeBuilder();
    failing.failProjectCreation();
    try {
      const home = makeHome();
      const result = await runCli({
        args: ['setup'],
        env: { SEQUENCE_BUILDER_API_URL: failing.url },
        home
      });
      expect(result.exitCode).equal(1);
      expect(result.stdout).equal('');
      expect(result.stderrJson).property('ok').equal(false);
      expect(result.stderrJson).property('error').contain('CreateProject failed');
      expect(fs.existsSync(path.join(home, 'builder.json'))).equal(false);
      expect(tripwireHits()).deep.equal([]);
    } finally {
      await failing.close();
    }
  });
});

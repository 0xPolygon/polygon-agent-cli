import type { Server } from 'node:http';

import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe('setup', { timeout: 30000 }, () => {
  let server!: Server;
  let home!: string;
  const prevEnv = {
    home: process.env.POLYGON_AGENT_HOME,
    api: process.env.SEQUENCE_BUILDER_API_URL
  };

  beforeAll(async () => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-setup-test-')));
    server = createServer((req, res) => {
      req.resume();
      const body = req.url?.endsWith('/GetAuthToken')
        ? { ok: true, auth: { jwtToken: 'test-jwt' } }
        : req.url?.endsWith('/CreateProject')
          ? { project: { id: 42, name: 'test-project' } }
          : { accessKey: { accessKey: 'test-access-key' } };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    process.env.SEQUENCE_BUILDER_API_URL = `http://127.0.0.1:${address.port}`;
    // STORAGE_DIR is resolved at module load, so set it before the dynamic import.
    process.env.POLYGON_AGENT_HOME = home;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
    for (const [key, value] of [
      ['POLYGON_AGENT_HOME', prevEnv.home],
      ['SEQUENCE_BUILDER_API_URL', prevEnv.api]
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('setup JSON output matches the interactive output: no key material', async () => {
    const { setupCommand } = await import('./setup.ts');
    const { loadBuilderConfig } = await import('../lib/storage.ts');

    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let stdout = '';
    try {
      await (setupCommand.handler as (argv: object) => Promise<void>)({ name: 'test-agent' });
      stdout = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    } finally {
      logSpy.mockRestore();
      if (ttyDescriptor) Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }

    const output = JSON.parse(stdout);
    const stored = await loadBuilderConfig();
    if (!stored) throw new Error('setup did not store a builder config');

    expect(output).property('ok').equal(true);
    expect(output).not.property('privateKey');
    expect(stdout).not.include(stored.privateKey);
    expect(stdout).not.include(stored.privateKey.replace(/^0x/, ''));
    expect(output).property('eoaAddress').equal(stored.eoaAddress);
    expect(output).property('accessKey').equal('test-access-key');
    expect(output).property('projectId').equal(42);
  });
});

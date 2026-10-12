import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PickInput } from './signin-method.ts';

import { currentSignInMethod, pickSignInMethod } from './signin-method.ts';
import { initWorkspace } from './workspace.ts';

const base: PickInput = { env: {}, os: 'darwin', dockerenv: false };

describe('pickSignInMethod', () => {
  const cases: Array<[string, Partial<PickInput>, string, string]> = [
    [
      'override browser beats muse',
      { env: { POLYGON_AGENT_SIGNIN: 'browser' }, platform: 'muse' },
      'browser',
      'POLYGON_AGENT_SIGNIN'
    ],
    [
      'override email beats desktop',
      { env: { POLYGON_AGENT_SIGNIN: 'email' } },
      'email',
      'POLYGON_AGENT_SIGNIN'
    ],
    ['invalid override ignored', { env: { POLYGON_AGENT_SIGNIN: 'nope' } }, 'browser', 'desktop'],
    ['muse', { platform: 'muse' }, 'email', 'platform muse'],
    ['openclaw', { platform: 'openclaw' }, 'email', 'platform openclaw'],
    ['hermes', { platform: 'hermes' }, 'email', 'platform hermes'],
    ['claude-code falls through to desktop', { platform: 'claude-code' }, 'browser', 'desktop'],
    [
      'claude-code in ssh',
      { platform: 'claude-code', env: { SSH_TTY: '/dev/pts/0' } },
      'email',
      'ssh session'
    ],
    ['ci', { env: { CI: 'true' } }, 'email', 'ci'],
    ['ssh connection', { env: { SSH_CONNECTION: 'a b c d' } }, 'email', 'ssh session'],
    ['ssh tty', { env: { SSH_TTY: '/dev/pts/0' } }, 'email', 'ssh session'],
    ['container', { dockerenv: true }, 'email', 'container'],
    ['linux no display', { os: 'linux' }, 'email', 'no display'],
    ['linux x11', { os: 'linux', env: { DISPLAY: ':0' } }, 'browser', 'desktop'],
    ['linux wayland', { os: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } }, 'browser', 'desktop'],
    ['darwin', { os: 'darwin' }, 'browser', 'desktop'],
    ['win32', { os: 'win32' }, 'browser', 'desktop']
  ];
  it.each(cases)('%s', (_name, input, method, reason) => {
    expect(pickSignInMethod({ ...base, ...input })).toEqual({ method, reason });
  });
});

describe('currentSignInMethod', () => {
  const saved = { ...process.env };
  let dir: string;
  beforeEach(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-signin-')), '.polygon-agent');
    delete process.env.POLYGON_AGENT_SIGNIN;
    delete process.env.CI;
    delete process.env.SSH_CONNECTION;
    delete process.env.SSH_TTY;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('returns email in a workspace initialised with --platform muse', () => {
    initWorkspace({ root: dir, version: '0.14.0', sourceDir: null, platform: 'muse' });
    process.env.POLYGON_AGENT_ROOT = dir;
    expect(currentSignInMethod()).toEqual({ method: 'email', reason: 'platform muse' });
  });
});

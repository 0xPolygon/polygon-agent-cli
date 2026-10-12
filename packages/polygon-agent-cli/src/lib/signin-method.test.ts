import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PickInput } from './signin-method.ts';

import { currentSignInMethod, inContainer, pickSignInMethod } from './signin-method.ts';
import { initWorkspace } from './workspace.ts';

const base: PickInput = { env: {}, os: 'darwin', container: false, stdinTTY: false };

describe('pickSignInMethod', () => {
  const cases: Array<[string, Partial<PickInput>, string, string]> = [
    [
      'override browser beats muse',
      { env: { POLYGON_AGENT_SIGNIN: 'browser' }, platform: 'muse' },
      'browser',
      'POLYGON_AGENT_SIGNIN'
    ],
    [
      'override email beats a terminal',
      { env: { POLYGON_AGENT_SIGNIN: 'email' }, stdinTTY: true },
      'email',
      'POLYGON_AGENT_SIGNIN'
    ],
    [
      'override browser beats ssh',
      { env: { POLYGON_AGENT_SIGNIN: 'browser', SSH_TTY: '/dev/pts/0' } },
      'browser',
      'POLYGON_AGENT_SIGNIN'
    ],
    ['invalid override ignored', { env: { POLYGON_AGENT_SIGNIN: 'nope' } }, 'email', 'default'],
    ['muse', { platform: 'muse' }, 'email', 'platform muse'],
    ['openclaw', { platform: 'openclaw' }, 'email', 'platform openclaw'],
    ['hermes in a terminal', { platform: 'hermes', stdinTTY: true }, 'email', 'platform hermes'],
    ['claude-code on darwin', { platform: 'claude-code' }, 'browser', 'platform claude-code'],
    ['cursor on darwin', { platform: 'cursor' }, 'browser', 'platform cursor'],
    ['codex on win32', { platform: 'codex', os: 'win32' }, 'browser', 'platform codex'],
    [
      'claude-code over ssh',
      { platform: 'claude-code', env: { SSH_TTY: '/dev/pts/0' } },
      'email',
      'ssh session'
    ],
    [
      'claude-code in a container',
      { platform: 'claude-code', container: true },
      'email',
      'container'
    ],
    ['ci', { env: { CI: 'true' }, stdinTTY: true }, 'email', 'ci'],
    ['ssh connection', { env: { SSH_CONNECTION: 'a b c d' } }, 'email', 'ssh session'],
    [
      'ssh tty in a terminal',
      { env: { SSH_TTY: '/dev/pts/0' }, stdinTTY: true },
      'email',
      'ssh session'
    ],
    ['container', { container: true, stdinTTY: true }, 'email', 'container'],
    ['linux no display', { os: 'linux', stdinTTY: true }, 'email', 'no display'],
    ['terminal on darwin', { stdinTTY: true }, 'browser', 'terminal'],
    [
      'terminal on linux x11',
      { os: 'linux', env: { DISPLAY: ':0' }, stdinTTY: true },
      'browser',
      'terminal'
    ],
    [
      'terminal on linux wayland',
      { os: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, stdinTTY: true },
      'browser',
      'terminal'
    ],
    // Hosted bots (Grokbot shapes): no terminal, no local coding agent.
    ['darwin, no platform', {}, 'email', 'default'],
    ['darwin, platform other', { platform: 'other' }, 'email', 'default'],
    [
      'linux with a virtual display, platform other',
      { os: 'linux', env: { DISPLAY: ':99' }, platform: 'other' },
      'email',
      'default'
    ],
    [
      'kubernetes pod',
      { os: 'linux', env: { DISPLAY: ':99' }, container: true },
      'email',
      'container'
    ],
    ['win32, no platform', { os: 'win32' }, 'email', 'default']
  ];
  it.each(cases)('%s', (_name, input, method, reason) => {
    expect(pickSignInMethod({ ...base, ...input })).toEqual({ method, reason });
  });
});

describe('inContainer', () => {
  const none = {
    env: {},
    exists: () => false,
    readFile: (): string => {
      throw new Error('ENOENT');
    }
  };

  it('is false with no signal (and an unreadable cgroup file)', () => {
    expect(inContainer(none)).toBe(false);
  });
  it('sees /.dockerenv', () => {
    expect(inContainer({ ...none, exists: (p) => p === '/.dockerenv' })).toBe(true);
  });
  it('sees /run/.containerenv', () => {
    expect(inContainer({ ...none, exists: (p) => p === '/run/.containerenv' })).toBe(true);
  });
  it('sees KUBERNETES_SERVICE_HOST', () => {
    expect(inContainer({ ...none, env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' } })).toBe(true);
  });
  it.each(['docker', 'kubepods', 'containerd', 'lxc', 'podman'])(
    'sees %s in /proc/1/cgroup',
    (word) => {
      const readFile = (p: string) => (p === '/proc/1/cgroup' ? `0::/${word}/abc\n` : '');
      expect(inContainer({ ...none, readFile })).toBe(true);
    }
  );
  it('ignores a plain host cgroup', () => {
    expect(inContainer({ ...none, readFile: () => '0::/init.scope\n' })).toBe(false);
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

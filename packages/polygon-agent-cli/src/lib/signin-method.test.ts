import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    ['win32, no platform', { os: 'win32' }, 'email', 'default'],
    // No recorded platform: Claude Code is recognised by the CLAUDECODE it sets.
    [
      'CLAUDECODE on darwin, no platform',
      { env: { CLAUDECODE: '1' } },
      'browser',
      'platform claude-code'
    ],
    [
      'CLAUDECODE over ssh',
      { env: { CLAUDECODE: '1', SSH_CONNECTION: 'a b c d' } },
      'email',
      'ssh session'
    ],
    [
      'CLAUDECODE in a container',
      { env: { CLAUDECODE: '1' }, container: true },
      'email',
      'container'
    ],
    [
      'CLAUDECODE on linux with no display',
      { env: { CLAUDECODE: '1' }, os: 'linux' },
      'email',
      'no display'
    ],
    [
      'a recorded platform beats CLAUDECODE',
      { env: { CLAUDECODE: '1' }, platform: 'other' },
      'email',
      'default'
    ],
    ['CLAUDECODE other than 1 is ignored', { env: { CLAUDECODE: '0' } }, 'email', 'default']
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
    delete process.env.CLAUDECODE;
    delete process.env.KUBERNETES_SERVICE_HOST;
    // A desktop-looking host whatever machine runs the tests.
    process.env.DISPLAY = ':0';
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', { value: savedTTY, configurable: true });
  });
  const savedTTY = process.stdin.isTTY;

  // No container markers, whatever machine runs the tests.
  function noContainer(extra: (p: string) => boolean = () => false): void {
    const exists = fs.existsSync;
    const read = fs.readFileSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((p) =>
      p === '/.dockerenv' || p === '/run/.containerenv' ? extra(String(p)) : exists(p)
    );
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) => {
      if (p === '/proc/1/cgroup') throw new Error('ENOENT');
      return read(p, o as never);
    }) as typeof fs.readFileSync);
  }

  it('passes the real stdin TTY into the picker', () => {
    noContainer();
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    expect(currentSignInMethod()).toEqual({ method: 'browser', reason: 'terminal' });
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    expect(currentSignInMethod()).toEqual({ method: 'email', reason: 'default' });
  });

  it('passes the real container check into the picker', () => {
    noContainer((p) => p === '/.dockerenv');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    expect(currentSignInMethod()).toEqual({ method: 'email', reason: 'container' });
  });

  it('reads CLAUDECODE from the real environment', () => {
    noContainer();
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    process.env.CLAUDECODE = '1';
    expect(currentSignInMethod()).toEqual({ method: 'browser', reason: 'platform claude-code' });
  });

  it('returns email in a workspace initialised with --platform muse', () => {
    initWorkspace({ root: dir, version: '0.14.0', sourceDir: null, platform: 'muse' });
    process.env.POLYGON_AGENT_ROOT = dir;
    expect(currentSignInMethod()).toEqual({ method: 'email', reason: 'platform muse' });
  });
});

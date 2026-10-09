import type * as ChildProcess from 'node:child_process';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Version from '../lib/version.ts';

import { initWorkspace, readInstallRecord } from '../lib/workspace.ts';
import { skillsCommand, updateCommand } from './workspace.ts';

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  getLatestVersion: vi.fn(),
  cliVersion: vi.fn()
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawnSync: mocks.spawnSync
}));
vi.mock('../lib/version.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Version>()),
  cliVersion: mocks.cliVersion,
  getLatestVersion: mocks.getLatestVersion
}));

const CLI_ENTRY = path.join('node_modules', '@polygonlabs', 'agent-cli', 'dist', 'index.js');

let root: string;

// A workspace install whose cli/ holds a CLI marked with `marker`.
function makeWorkspace(): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-update-')), '.polygon-agent');
  initWorkspace({ root: dir, version: '0.14.0', name: 'Test', sourceDir: null });
  writeCli(path.join(dir, 'cli'), 'old');
  return dir;
}

function writeCli(prefix: string, marker: string): void {
  fs.mkdirSync(path.dirname(path.join(prefix, CLI_ENTRY)), { recursive: true });
  fs.writeFileSync(path.join(prefix, CLI_ENTRY), marker);
}

function cliMarker(): string {
  return fs.readFileSync(path.join(root, 'cli', CLI_ENTRY), 'utf8');
}

// npm install --prefix <dir>: writes the new CLI there.
function npmInstalls(marker: string) {
  return (_file: string, args: string[]) => {
    writeCli(args[args.indexOf('--prefix') + 1], marker);
    return { status: 0 };
  };
}

function initPrints(output: unknown) {
  return () => ({ status: 0, stdout: JSON.stringify(output) });
}

async function update(): Promise<Record<string, unknown>> {
  if (typeof updateCommand.handler !== 'function') throw new Error('Missing update handler');
  await updateCommand.handler({ _: [], $0: 'polygon-agent' });
  return JSON.parse(String(vi.mocked(console.log).mock.calls[0][0]));
}

function errorOutput(): string {
  return JSON.parse(String(vi.mocked(console.error).mock.calls[0][0])).error;
}

beforeEach(() => {
  vi.resetAllMocks();
  root = makeWorkspace();
  vi.stubEnv('POLYGON_AGENT_ROOT', root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('CLI exited');
  });
  mocks.cliVersion.mockReturnValue('0.14.0');
  mocks.getLatestVersion.mockResolvedValue('0.15.0');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('update', () => {
  it('outside a workspace install, prints the global npm command and installs nothing', async () => {
    vi.stubEnv('POLYGON_AGENT_ROOT', '');
    expect(await update()).toMatchObject({
      ok: true,
      updated: false,
      latest: '0.15.0',
      command: 'npm install -g --ignore-scripts @polygonlabs/agent-cli@latest'
    });
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it('does nothing when already on the latest version', async () => {
    mocks.getLatestVersion.mockResolvedValue('0.14.0');
    expect(await update()).toEqual({
      ok: true,
      updated: false,
      version: '0.14.0',
      latest: '0.14.0'
    });
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it('installs beside the CLI, swaps it in, and re-runs the new CLI’s workspace init', async () => {
    vi.stubEnv('SEQUENCE_PROJECT_ACCESS_KEY', 'secret');
    vi.stubEnv('OMS_PUBLISHABLE_KEY', 'secret');
    const skill = { name: 'polygon-oms-wallet', installed: true, path: '/skills/x/SKILL.md' };
    mocks.spawnSync
      .mockImplementationOnce(npmInstalls('new'))
      .mockImplementationOnce(initPrints({ version: '0.15.0', skill }));

    expect(await update()).toEqual({
      ok: true,
      updated: true,
      from: '0.14.0',
      to: '0.15.0',
      skill
    });
    expect(cliMarker()).toBe('new');
    expect(fs.readdirSync(root).sort()).toEqual(['.gitignore', 'bin', 'cli', 'state']);

    const [npmFile, npmArgs, npmOpts] = mocks.spawnSync.mock.calls[0];
    expect(npmFile).toBe('npm');
    // The exact version checked, with install scripts off.
    expect(npmArgs).toEqual([
      'install',
      '--ignore-scripts',
      '--prefix',
      path.join(root, 'cli.next'),
      '@polygonlabs/agent-cli@0.15.0'
    ]);
    // npm's output must not reach stdout, which carries this command's JSON.
    expect(npmOpts.stdio).toEqual(['ignore', 2, 2]);
    expect(npmOpts.env.SEQUENCE_PROJECT_ACCESS_KEY).toBeUndefined();
    expect(npmOpts.env.OMS_PUBLISHABLE_KEY).toBeUndefined();
    expect(npmOpts.env.PATH).toBe(process.env.PATH);
    expect(mocks.spawnSync.mock.calls[1].slice(0, 2)).toEqual([
      path.join(root, 'bin', 'polygon-agent'),
      ['workspace', 'init', '--root', root]
    ]);
  });

  it('uses the workspace Node runtime’s npm when there is one', async () => {
    const npmCli = path.join(root, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    fs.mkdirSync(path.dirname(npmCli), { recursive: true });
    fs.writeFileSync(npmCli, '');
    mocks.spawnSync
      .mockImplementationOnce(npmInstalls('new'))
      .mockImplementationOnce(
        initPrints({ version: '0.15.0', skill: { name: 'polygon-oms-wallet', installed: false } })
      );
    await update();
    const [file, args] = mocks.spawnSync.mock.calls[0];
    expect(file).toBe(process.execPath);
    expect(args[0]).toBe(npmCli);
  });

  it('still installs when the registry can’t be reached', async () => {
    mocks.getLatestVersion.mockResolvedValue(null);
    mocks.spawnSync
      .mockImplementationOnce(npmInstalls('new'))
      .mockImplementationOnce(
        initPrints({ version: '0.14.0', skill: { name: 'polygon-oms-wallet', installed: false } })
      );
    expect(await update()).toMatchObject({ ok: true, updated: false, to: '0.14.0' });
    expect(mocks.spawnSync.mock.calls[0][1]).toContain('@polygonlabs/agent-cli@latest');
  });

  it('leaves the current CLI untouched when npm install fails', async () => {
    mocks.spawnSync.mockReturnValueOnce({ status: 1 });
    await expect(update()).rejects.toThrow('CLI exited');
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    expect(errorOutput()).toContain('npm install exited');
    expect(cliMarker()).toBe('old');
  });

  it('leaves the current CLI untouched when npm reports success but installed nothing', async () => {
    mocks.spawnSync.mockReturnValueOnce({ status: 0 });
    await expect(update()).rejects.toThrow('CLI exited');
    expect(errorOutput()).toContain('without @polygonlabs/agent-cli');
    expect(cliMarker()).toBe('old');
  });

  it('rolls back to the previous CLI when the new CLI’s init fails', async () => {
    mocks.spawnSync
      .mockImplementationOnce(npmInstalls('new'))
      .mockReturnValueOnce({ status: 1, stdout: 'Unknown arguments' });
    await expect(update()).rejects.toThrow('CLI exited');
    expect(errorOutput()).toContain('rolled back to 0.14.0');
    expect(cliMarker()).toBe('old');
    expect(fs.readdirSync(root).sort()).toEqual(['.gitignore', 'bin', 'cli', 'state']);
    expect(readInstallRecord(path.join(root, 'state'))).toMatchObject({
      name: 'Test',
      version: '0.14.0'
    });
  });
});

describe('update concurrency', () => {
  it('refuses while another live process is updating, leaving the CLI untouched', async () => {
    const lockDir = path.join(root, 'state', 'update.lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, '000000000001.json'),
      JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: 'now' })
    );
    await expect(update()).rejects.toThrow('CLI exited');
    expect(errorOutput()).toMatch(/holds .*update\.lock/);
    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(cliMarker()).toBe('old');
  });

  it('two overlapping updates leave exactly one working CLI', async () => {
    const skill = { name: 'polygon-oms-wallet', installed: false };
    let second: Promise<unknown> | undefined;
    mocks.spawnSync.mockImplementation((file: string, args: string[]) => {
      if (args.includes('install')) {
        // A second update starts while the first is mid-install.
        second ??= updateCommand.handler?.({ _: [], $0: 'polygon-agent' }) ?? undefined;
        return npmInstalls('new')(file, args);
      }
      return initPrints({ version: '0.15.0', skill })();
    });

    const first = updateCommand.handler?.({ _: [], $0: 'polygon-agent' });
    const results = await Promise.allSettled([first, second]);
    // second is set once the first update reaches npm.
    const settled = await Promise.allSettled([second]);

    expect([...results, ...settled].filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(errorOutput()).toMatch(/holds .*update\.lock/);
    expect(cliMarker()).toBe('new');
    expect(fs.readdirSync(root).sort()).toEqual(['.gitignore', 'bin', 'cli', 'state']);
    // Released: every generation left in the lock directory is marked released.
    const lockDir = path.join(root, 'state', 'update.lock');
    for (const name of fs.readdirSync(lockDir)) {
      expect(JSON.parse(fs.readFileSync(path.join(lockDir, name), 'utf8'))).toMatchObject({
        released: true
      });
    }
  });
});

describe('skills install', () => {
  async function install(args: { name: string; dir: string }): Promise<void> {
    const yargs = (await import('yargs')).default;
    await yargs()
      .command(skillsCommand)
      .parseAsync(['skills', 'install', args.name, '--dir', args.dir]);
  }

  it('writes a bundled skill, rendered for the workspace wrapper', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-skills-'));
    await install({ name: 'polygon-agent-cli', dir });
    const file = path.join(dir, 'polygon-agent-cli', 'SKILL.md');
    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0][0]))).toEqual({
      ok: true,
      skill: 'polygon-agent-cli',
      path: file
    });
    expect(fs.readFileSync(file, 'utf8')).toContain(
      `\`${path.join(root, 'bin', 'polygon-agent')}\``
    );
  });
});

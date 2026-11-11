import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Tripwire } from './tripwire.ts';

import { startTripwire } from './tripwire.ts';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliEntry = path.join(pkgDir, 'dist', 'index.js');

export interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Parsed stdout / stderr when they are JSON; undefined otherwise. */
  stdoutJson: unknown;
  stderrJson: unknown;
  /** The state dir (also HOME) the child ran with. */
  home: string;
}

const homes = new Set<string>();
let tripwire: Tripwire | undefined;

// realpath: on macOS the tmpdir is a symlink, and the CLI resolves its state dir.
export function makeHome(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-test-')));
  homes.add(dir);
  return dir;
}

export async function cleanupHarness(): Promise<void> {
  for (const dir of homes) fs.rmSync(dir, { recursive: true, force: true });
  homes.clear();
  await tripwire?.close();
  tripwire = undefined;
}

/** Outbound attempts recorded since the last `resetTripwire()`. */
export function tripwireHits(): string[] {
  return tripwire ? [...tripwire.hits] : [];
}

export function resetTripwire(): void {
  if (tripwire) tripwire.hits.length = 0;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Allowlist, never process.env: developer API keys must not reach the child.
export async function runNode(params: {
  nodeArgs: string[];
  env?: Record<string, string>;
  home?: string;
  timeoutMs?: number;
}): Promise<CliResult> {
  const home = params.home ?? makeHome();
  tripwire ??= await startTripwire();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    POLYGON_AGENT_HOME: home,
    NO_COLOR: '1',
    NODE_USE_ENV_PROXY: '1',
    HTTP_PROXY: tripwire.url,
    HTTPS_PROXY: tripwire.url,
    NO_PROXY: '127.0.0.1,localhost',
    ...params.env
  };
  return new Promise((resolve, reject) => {
    // Async spawn: the tripwire lives in this process and must keep serving.
    const child = spawn(process.execPath, params.nodeArgs, {
      cwd: pkgDir,
      env,
      timeout: params.timeoutMs ?? 30_000,
      killSignal: 'SIGKILL'
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (exitCode) =>
      resolve({
        exitCode,
        stdout,
        stderr,
        stdoutJson: parseJson(stdout),
        stderrJson: parseJson(stderr),
        home
      })
    );
  });
}

export function runCli(params: {
  args: string[];
  env?: Record<string, string>;
  home?: string;
  timeoutMs?: number;
}): Promise<CliResult> {
  return runNode({ ...params, nodeArgs: [cliEntry, ...params.args] });
}

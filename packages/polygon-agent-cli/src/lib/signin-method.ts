import fs from 'node:fs';

import type { Platform } from './workspace.ts';

import { PLATFORMS, readInstallRecord, stateDir } from './workspace.ts';

export type SignInMethod = 'browser' | 'email';

// Defined in workspace.ts (install.json stores it); re-exported here.
export { PLATFORMS, type Platform };

export interface PickInput {
  env: NodeJS.ProcessEnv;
  platform?: Platform;
  os: NodeJS.Platform;
  // Running in a container (see inContainer).
  container: boolean;
  // stdin is a TTY: a person is typing in a terminal.
  stdinTTY: boolean;
}

// Chat assistants: the user is in a chat, often on a phone, even when the
// assistant's own sandbox runs commands in a terminal.
const EMAIL_PLATFORMS: readonly Platform[] = ['muse', 'openclaw', 'hermes', 'grok'];
// Local coding agents: they run on the user's desktop, next to a browser.
const DESKTOP_PLATFORMS: readonly Platform[] = ['claude-code', 'cursor', 'codex'];

// A platform that marks its own environment, for an install with none recorded.
// Only markers known to be set: Claude Code sets CLAUDECODE=1.
function platformFromEnv(env: NodeJS.ProcessEnv): Platform | undefined {
  return env.CLAUDECODE === '1' ? 'claude-code' : undefined;
}

// Email is the default: the browser is picked only on positive evidence of a
// person at a desktop. First match wins. Pure: every input is passed in.
export function pickSignInMethod(input: PickInput): { method: SignInMethod; reason: string } {
  const { env } = input;
  const platform = input.platform ?? platformFromEnv(env);
  const override = env.POLYGON_AGENT_SIGNIN;
  if (override === 'browser' || override === 'email') {
    return { method: override, reason: 'POLYGON_AGENT_SIGNIN' };
  }
  if (platform && EMAIL_PLATFORMS.includes(platform)) {
    return { method: 'email', reason: `platform ${platform}` };
  }
  if (env.CI) return { method: 'email', reason: 'ci' };
  if (env.SSH_CONNECTION || env.SSH_TTY) return { method: 'email', reason: 'ssh session' };
  if (input.container) return { method: 'email', reason: 'container' };
  if (input.os === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return { method: 'email', reason: 'no display' };
  }
  if (input.stdinTTY) return { method: 'browser', reason: 'terminal' };
  if (platform && DESKTOP_PLATFORMS.includes(platform)) {
    return { method: 'browser', reason: `platform ${platform}` };
  }
  return { method: 'email', reason: 'default' };
}

const CONTAINER_CGROUP = /docker|kubepods|containerd|lxc|podman/;

// Container markers. Best effort: a file that can't be read is no signal.
export function inContainer(params: {
  env: NodeJS.ProcessEnv;
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
}): boolean {
  if (params.exists('/.dockerenv') || params.exists('/run/.containerenv')) return true;
  if (params.env.KUBERNETES_SERVICE_HOST) return true;
  try {
    return CONTAINER_CGROUP.test(params.readFile('/proc/1/cgroup'));
  } catch {
    return false;
  }
}

// Reads the real environment. Inside a workspace install the wrapper sets
// POLYGON_AGENT_ROOT, and that install's record holds the platform.
export function currentSignInMethod(): { method: SignInMethod; reason: string } {
  const root = process.env.POLYGON_AGENT_ROOT;
  const platform = root ? readInstallRecord(stateDir(root))?.platform : undefined;
  return pickSignInMethod({
    env: process.env,
    platform,
    os: process.platform,
    container: inContainer({
      env: process.env,
      exists: (p) => fs.existsSync(p),
      readFile: (p) => fs.readFileSync(p, 'utf8')
    }),
    stdinTTY: process.stdin.isTTY === true
  });
}

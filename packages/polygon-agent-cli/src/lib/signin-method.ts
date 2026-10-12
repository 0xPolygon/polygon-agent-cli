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
  dockerenv: boolean;
}

const EMAIL_PLATFORMS: readonly Platform[] = ['muse', 'openclaw', 'hermes'];

// First match wins. Pure: every input is passed in.
export function pickSignInMethod(input: PickInput): { method: SignInMethod; reason: string } {
  const { env, platform } = input;
  const override = env.POLYGON_AGENT_SIGNIN;
  if (override === 'browser' || override === 'email') {
    return { method: override, reason: 'POLYGON_AGENT_SIGNIN' };
  }
  if (platform && EMAIL_PLATFORMS.includes(platform)) {
    return { method: 'email', reason: `platform ${platform}` };
  }
  if (env.CI) return { method: 'email', reason: 'ci' };
  if (env.SSH_CONNECTION || env.SSH_TTY) return { method: 'email', reason: 'ssh session' };
  if (input.dockerenv) return { method: 'email', reason: 'container' };
  if (input.os === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return { method: 'email', reason: 'no display' };
  }
  return { method: 'browser', reason: 'desktop' };
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
    dockerenv: fs.existsSync('/.dockerenv')
  });
}

// The wallet lock must survive logout's cleanup: deleting a lock's directory
// would let its generation numbers start over (see lib/lock.ts).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-state-'));

const { removeSessionState, sessionDir, withWalletLock } = await import('./state.ts');

const lockDir = (wallet: string) =>
  path.join(String(process.env.POLYGON_AGENT_HOME), 'locks', 'wallets', `${wallet}.lock`);

describe('wallet lock', () => {
  it('lives outside the session state, so removing that state keeps its generations', async () => {
    const wallet = 'w1';
    await withWalletLock({
      wallet,
      fn: async () => {
        expect(lockDir(wallet).startsWith(sessionDir(wallet))).toBe(false);
        removeSessionState(wallet);
      }
    });
    expect(fs.readdirSync(lockDir(wallet))).toEqual(['000000000001.json']);

    let during: string[] = [];
    await withWalletLock({ wallet, fn: async () => (during = fs.readdirSync(lockDir(wallet))) });
    expect(during).toEqual(['000000000002.json']);
  });
});

// Wallet names end up in paths that are written and deleted recursively: a
// name that climbs out of the state folder must be refused before any of that.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-outside-'));
process.env.POLYGON_AGENT_HOME = path.join(outside, 'home', 'state');
fs.mkdirSync(process.env.POLYGON_AGENT_HOME, { recursive: true });
const sentinel = path.join(outside, 'keep-me.txt');
fs.writeFileSync(sentinel, 'x');

const { deleteOmsWallet, loadOmsWalletPointer, walletName } = await import('./storage.ts');
const { removeSessionState, sessionDir } = await import('./session/state.ts');
const { loadPending } = await import('./owner/pending.ts');

const HOSTILE = ['..', '../..', '../../..', 'a/b', '.hidden', '', 'x'.repeat(65), 'a\nb'];

describe('wallet names', () => {
  it('accepts ordinary names', () => {
    for (const name of ['main', 'Work-2', 'flow_1', 'my.wallet']) {
      expect(walletName(name)).toBe(name);
    }
  });

  it.each(HOSTILE)('refuses %j everywhere a path is built from it', async (name) => {
    await expect(deleteOmsWallet(name)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(loadOmsWalletPointer(name)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(() => removeSessionState(name)).toThrow(/Invalid wallet name/);
    expect(() => sessionDir(name)).toThrow(/Invalid wallet name/);
    expect(() => loadPending(name)).toThrow(/Invalid wallet name/);
    expect(fs.existsSync(sentinel)).toBe(true);
  });
});

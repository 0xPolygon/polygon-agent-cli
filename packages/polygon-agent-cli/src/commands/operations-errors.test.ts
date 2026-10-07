// Spending commands report session-mode refusals with their structured code,
// hint and command (architecture §10), not just the message.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ops-errors-'));

const { sendNativeCommand } = await import('./operations.ts');
const { saveOmsWalletPointer } = await import('../lib/storage.ts');

beforeEach(async () => {
  await saveOmsWalletPointer('main', {
    walletAddress: '0xd384ea24ca0B3a5e4BB35935C611E3dCB68Fd08e',
    loginMethod: 'email',
    createdAt: 'x',
    access: 'session'
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('CLI exited');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('spending command errors', () => {
  it('send-native in session mode fails with native_not_supported', async () => {
    const yargs = (await import('yargs')).default;
    await yargs()
      .command(sendNativeCommand)
      .parseAsync([
        'send-native',
        '--to',
        '0x1D17C0F90A0b3dFb5124C2FF56B33a0D2E202e1d',
        '--amount',
        '0.1',
        '--broadcast'
      ])
      .catch(() => undefined);
    const json = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .filter((line) => line.startsWith('{'));
    const out = JSON.parse(json[0]);
    expect(out).toMatchObject({ ok: false, code: 'native_not_supported' });
    expect(out.stack).toBeUndefined();
  });
});

// Polymarket writes are signed by the Polymarket EOA, outside the allowance,
// so an install with a session-mode wallet refuses all of them.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as PolymarketLib from '../lib/polymarket/gamma.ts';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-polymarket-'));

const mocks = vi.hoisted(() => ({ getMarket: vi.fn() }));
vi.mock('../lib/polymarket/gamma.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof PolymarketLib>()),
  getMarket: mocks.getMarket
}));

const { polymarketCommand } = await import('./polymarket.ts');
const { deleteOmsWallet, saveOmsWalletPointer } = await import('../lib/storage.ts');

async function run(argv: string[]): Promise<Record<string, unknown>> {
  const yargs = (await import('yargs')).default;
  await yargs()
    .command(polymarketCommand)
    .parseAsync(['polymarket', ...argv])
    .catch(() => undefined);
  const lines = vi
    .mocked(console.error)
    .mock.calls.map((call) => String(call[0]))
    .filter((line) => line.startsWith('{'));
  return JSON.parse(lines.at(-1) ?? '{}');
}

beforeEach(async () => {
  await saveOmsWalletPointer('main', {
    walletAddress: '0xd384ea24ca0B3a5e4BB35935C611E3dCB68Fd08e',
    loginMethod: 'email',
    createdAt: 'x',
    access: 'session'
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('CLI exited');
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await deleteOmsWallet('main');
  await deleteOmsWallet('other');
});

describe('polymarket in a session-mode install', () => {
  it.each([
    ['clob-buy --skip-fund', ['clob-buy', '0xcond', 'YES', '5', '--skip-fund', '--broadcast']],
    ['clob-buy naming another wallet', ['clob-buy', '0xcond', 'YES', '5', '--wallet', 'other']],
    ['approve', ['approve', '--broadcast']],
    ['sell', ['sell', '0xcond', 'YES', '5', '--broadcast']]
  ])('%s is refused with owner_required, before anything runs', async (_label, argv) => {
    expect(await run(argv)).toMatchObject({ ok: false, code: 'owner_required' });
    expect(mocks.getMarket).not.toHaveBeenCalled();
  });

  it('owner-mode installs are not refused', async () => {
    await saveOmsWalletPointer('main', {
      walletAddress: '0xd384ea24ca0B3a5e4BB35935C611E3dCB68Fd08e',
      loginMethod: 'google',
      createdAt: 'x'
    });
    mocks.getMarket.mockRejectedValueOnce(new Error('market lookup reached'));
    expect(await run(['sell', '0xcond', 'YES', '5'])).toMatchObject({
      ok: false,
      error: 'market lookup reached'
    });
  });
});

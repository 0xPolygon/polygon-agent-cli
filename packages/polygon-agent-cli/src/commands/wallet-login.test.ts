// `wallet login` wallet selection: the pointer always holds the main wallet, and a login to a
// different account is refused unless --force.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-login-'));

const MAIN = '0xd384ea24ca0B3a5e4BB35935C611E3dCB68Fd08e';
const IMPORTED = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';

type W = { id: string; address: string; keyOrigin: 'generated' | 'imported' };
const fake = vi.hoisted(() => ({
  wallets: [] as W[],
  active: undefined as string | undefined,
  calls: [] as string[],
  // What the sign-in auto-selects.
  auto: undefined as string | undefined,
  signedIn: false
}));

vi.mock('../lib/oms-client.ts', () => ({
  getOmsClient: () => ({
    wallet: {
      get walletAddress() {
        return fake.active;
      },
      listWallets: async () => fake.wallets,
      useWallet: async ({ walletId }: { walletId: string }) => {
        fake.calls.push(`useWallet:${walletId}`);
        fake.active = fake.wallets.find((w) => w.id === walletId)?.address;
      },
      signOut: async () => {
        fake.calls.push('signOut');
        fake.active = undefined;
      }
    }
  }),
  loginUiBaseUrl: () => 'https://ui.test',
  oidcRelayBaseUrl: () => 'https://relay.test'
}));
vi.mock('../lib/login-relay-client.ts', () => ({ makeLoginRelay: () => ({}) }));
vi.mock('../lib/browser-login.ts', () => ({
  // Signs in (auto-selecting `fake.auto`) then runs the injected selection, like the real loop.
  runBrowserLogin: async (deps: { selectMainWallet(): Promise<{ address: string }> }) => {
    fake.active = fake.auto;
    const main = await deps.selectMainWallet();
    return { walletAddress: main.address, loginMethod: 'google' };
  }
}));
vi.mock('../lib/builder-provision.ts', () => ({
  provisionBuilderOnce: async () => ({ provisioned: false, reason: 'existing' })
}));

const { walletCommand } = await import('./wallet.ts');
const { loadOmsWalletPointer, saveOmsWalletPointer } = await import('../lib/storage.ts');

let name = '';
let counter = 0;

async function login(...flags: string[]): Promise<void> {
  const yargs = (await import('yargs')).default;
  await yargs()
    .command(walletCommand)
    .parseAsync(['wallet', 'login', '--name', name, '--no-fund', ...flags]);
}

function jsonLines(spy: 'log' | 'error'): Array<Record<string, unknown>> {
  return vi
    .mocked(console[spy])
    .mock.calls.map((c) => String(c[0]))
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l));
}

beforeEach(() => {
  name = `login${++counter}`;
  fake.wallets = [
    { id: 'w-imp', address: IMPORTED, keyOrigin: 'imported' },
    { id: 'w-main', address: MAIN, keyOrigin: 'generated' }
  ];
  fake.active = undefined;
  fake.auto = IMPORTED;
  fake.calls.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('CLI exited');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('wallet login selection', () => {
  it('saves the main wallet when sign-in auto-selected the imported one', async () => {
    await login();
    expect((await loadOmsWalletPointer(name))?.walletAddress).toBe(MAIN);
    expect(fake.calls).toContain('useWallet:w-main');
  });

  it('refuses a different account without --force, signs out, and keeps the pointer', async () => {
    await saveOmsWalletPointer(name, {
      walletAddress: OTHER,
      loginMethod: 'google',
      createdAt: ''
    });
    await login().catch(() => undefined);
    const err = jsonLines('error')[0];
    expect(err).toMatchObject({
      code: 'invalid_input',
      hint: 'Run wallet logout first, or pass --force to replace this wallet.'
    });
    expect(String(err.error)).toContain(OTHER);
    expect(fake.calls).toContain('signOut');
    expect((await loadOmsWalletPointer(name))?.walletAddress).toBe(OTHER);
  });

  it('--force replaces the pointer with the new account main wallet', async () => {
    await saveOmsWalletPointer(name, {
      walletAddress: OTHER,
      loginMethod: 'google',
      createdAt: ''
    });
    await login('--force');
    expect((await loadOmsWalletPointer(name))?.walletAddress).toBe(MAIN);
    expect(fake.calls).not.toContain('signOut');
  });

  it('the already-logged-in short-circuit first moves a session off the imported wallet', async () => {
    await saveOmsWalletPointer(name, {
      walletAddress: MAIN,
      loginMethod: 'google',
      createdAt: ''
    });
    fake.active = IMPORTED;
    await login();
    expect(fake.calls).toContain('useWallet:w-main');
    expect(jsonLines('log')[0]).toMatchObject({ alreadyLoggedIn: true, walletAddress: MAIN });
  });
});

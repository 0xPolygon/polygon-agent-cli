// `wallet login --owner` wallet selection: the pointer always holds the main wallet, and a login
// to a different account is refused unless --force. Bare `wallet login` is session mode.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-login-'));

const MAIN = '0xd384ea24ca0B3a5e4BB35935C611E3dCB68Fd08e';
const IMPORTED = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';

type W = { id: string; address: string; keyOrigin: 'generated' | 'imported' };
const step = vi.hoisted(() => ({ fn: vi.fn() }));
const fake = vi.hoisted(() => ({
  wallets: [] as W[],
  active: undefined as string | undefined,
  calls: [] as string[],
  // What the sign-in auto-selects.
  auto: undefined as string | undefined,
  signedIn: false
}));

const funds = vi.hoisted(() => ({ funded: false, opened: [] as string[], checks: 0 }));
vi.mock('../lib/indexer.ts', () => ({
  isWalletFunded: async () => {
    funds.checks += 1;
    return funds.funded;
  }
}));
vi.mock('open', () => ({
  default: async (url: string) => {
    funds.opened.push(url);
  }
}));
vi.mock('../lib/polymarket/owner-step.ts', () => ({ polymarketOwnerStep: step.fn }));
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

async function ownerLogin(...flags: string[]): Promise<void> {
  return login('--owner', '--no-fund', ...flags);
}

async function login(...flags: string[]): Promise<void> {
  const yargs = (await import('yargs')).default;
  await yargs()
    .command(walletCommand)
    .parseAsync(['wallet', 'login', '--name', name, ...flags]);
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
  funds.funded = false;
  funds.opened.length = 0;
  funds.checks = 0;
  step.fn.mockReset();
  step.fn.mockResolvedValue({ backedUp: true, omsWalletId: 'w-key' });
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

describe('wallet login routing', () => {
  it('bare login refuses an owner-mode wallet and points owners at --owner', async () => {
    await saveOmsWalletPointer(name, { walletAddress: MAIN, loginMethod: 'google', createdAt: '' });
    await login().catch(() => undefined);
    expect(jsonLines('error')[0]).toMatchObject({ code: 'invalid_input' });
    expect(String(jsonLines('error')[0].error)).toContain('signed in with --owner');
    expect(vi.mocked(process.stderr.write).mock.calls.map((c) => String(c[0]))).toContain(
      'Note: `wallet login` now connects with an allowance; use `--owner` for the full owner session.\n'
    );
    expect(fake.calls).toEqual([]);
  });
});

describe('wallet login options', () => {
  it('--local and --remote need --owner', async () => {
    for (const flag of ['--local', '--remote']) {
      vi.mocked(console.error).mockClear();
      await login(flag).catch(() => undefined);
      expect(jsonLines('error')[0]).toMatchObject({
        code: 'invalid_input',
        error: '--local and --remote only work with --owner.'
      });
    }
    expect(fake.calls).toEqual([]);
  });

  it('--relay-url also sets the relay for the session-mode browser path (and its waiter)', async () => {
    const saved = process.env.POLYGON_AGENT_OIDC_RELAY;
    try {
      await saveOmsWalletPointer(name, {
        walletAddress: MAIN,
        loginMethod: 'google',
        createdAt: ''
      });
      await login('--relay-url', 'https://relay.example/').catch(() => undefined);
      expect(process.env.POLYGON_AGENT_OIDC_RELAY).toBe('https://relay.example');
    } finally {
      if (saved === undefined) delete process.env.POLYGON_AGENT_OIDC_RELAY;
      else process.env.POLYGON_AGENT_OIDC_RELAY = saved;
    }
  });
});

describe('wallet login --owner selection', () => {
  it('saves the main wallet when sign-in auto-selected the imported one', async () => {
    await ownerLogin();
    expect((await loadOmsWalletPointer(name))?.walletAddress).toBe(MAIN);
    expect(fake.calls).toContain('useWallet:w-main');
  });

  it('refuses a different account without --force, signs out, and keeps the pointer', async () => {
    await saveOmsWalletPointer(name, {
      walletAddress: OTHER,
      loginMethod: 'google',
      createdAt: ''
    });
    await ownerLogin().catch(() => undefined);
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
    await ownerLogin('--force');
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
    await ownerLogin();
    expect(fake.calls).toContain('useWallet:w-main');
    expect(jsonLines('log')[0]).toMatchObject({ alreadyLoggedIn: true, walletAddress: MAIN });
  });
});

describe('wallet login --owner polymarket backup', () => {
  const ownerArg = expect.objectContaining({ listWallets: expect.any(Function) });

  it('a fresh login backs up the key with the owner client and main address', async () => {
    await ownerLogin();
    expect(step.fn).toHaveBeenCalledWith({
      wallet: name,
      owner: ownerArg,
      mainAddress: MAIN,
      signsWithOms: true
    });
    expect(jsonLines('log')[0]).toMatchObject({
      ok: true,
      walletAddress: MAIN,
      polymarket: { backedUp: true, omsWalletId: 'w-key' }
    });
  });

  it('the already-logged-in path backs up the key too', async () => {
    await saveOmsWalletPointer(name, { walletAddress: MAIN, loginMethod: 'google', createdAt: '' });
    fake.active = MAIN;
    await ownerLogin();
    expect(step.fn).toHaveBeenCalledWith({
      wallet: name,
      owner: ownerArg,
      mainAddress: MAIN,
      signsWithOms: true
    });
    expect(jsonLines('log')[0]).toMatchObject({
      alreadyLoggedIn: true,
      polymarket: { backedUp: true }
    });
  });

  it('a rejecting step never fails the login', async () => {
    step.fn.mockRejectedValue(new Error('boom'));
    await ownerLogin();
    expect(jsonLines('log')[0]).toMatchObject({
      ok: true,
      polymarket: { backedUp: false, error: 'boom' }
    });
  });
});

describe('wallet login --owner dashboard link', () => {
  it('a fresh login of an empty wallet links the fund view', async () => {
    await ownerLogin();
    expect(jsonLines('log')[0]).toMatchObject({
      ok: true,
      dashboard: { url: `https://ui.test/?wallet=${MAIN}&chain=137&view=fund` }
    });
  });

  it('a funded wallet links the dashboard view, on the already-logged-in path too', async () => {
    funds.funded = true;
    await saveOmsWalletPointer(name, { walletAddress: MAIN, loginMethod: 'google', createdAt: '' });
    fake.active = MAIN;
    await ownerLogin();
    expect(jsonLines('log')[0]).toMatchObject({
      alreadyLoggedIn: true,
      dashboard: { url: `https://ui.test/?wallet=${MAIN}&chain=137&view=dashboard` }
    });
  });

  it('the funding step after login opens nothing and shares the one funded check', async () => {
    await login('--owner');
    const [result, panel] = jsonLines('log');
    expect(result).toMatchObject({
      ok: true,
      dashboard: { url: expect.stringContaining('view=fund') }
    });
    expect(panel).toMatchObject({
      funded: false,
      url: result?.dashboard && (result.dashboard as { url: string }).url
    });
    expect(funds.opened).toEqual([]);
    expect(funds.checks).toBe(1);
  });
});

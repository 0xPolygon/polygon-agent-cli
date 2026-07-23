import { describe, expect, it } from 'vitest';

import type {
  BrowserLoginDeps,
  BrowserLoginOpts,
  LoginAction,
  LoginStatus
} from './browser-login.ts';

import { runBrowserLogin } from './browser-login.ts';

// A sentinel standing in for the SDK's opaque OmsRelayOidcProviders.google value.
const GOOGLE_PROVIDER = Symbol('oms-relay-oidc-provider-google');

// A scripted fake: nextAction() pops the queue (null = pending tick), and every
// published status is recorded for assertions.
function makeFakes(actionQueue: Array<LoginAction | null>) {
  const statuses: LoginStatus[] = [];
  const calls: string[] = [];
  let time = 0;

  const deps: BrowserLoginDeps = {
    relay: {
      registerSession: async () => {
        calls.push('registerSession');
      },
      nextAction: async () => (actionQueue.length > 0 ? (actionQueue.shift() ?? null) : null),
      setStatus: async (_s, status) => {
        statuses.push(status);
      }
    },
    wallet: {
      startOidcRedirectAuth: async (p) => {
        calls.push(`startOidc:${String(p.provider === GOOGLE_PROVIDER)}:${p.omsRelayReturnUri}`);
        return { authorizationUrl: 'https://accounts.google.com/auth' };
      },
      completeOidcRedirectAuth: async (p) => {
        calls.push(`completeOidc:${p.callbackUrl}`);
        return { walletAddress: '0xW' };
      },
      startEmailAuth: async (p) => {
        calls.push(`startEmail:${p.email}`);
      },
      completeEmailAuth: async (p) => {
        calls.push(`completeEmail:${p.code}`);
        if (p.code === 'BAD') throw new Error('invalid code');
        return { walletAddress: '0xW' };
      }
    },
    oidcProviderGoogle: GOOGLE_PROVIDER,
    announce: async (url) => {
      calls.push(`announce:${url}`);
    },
    sleep: async () => {
      time += 1000;
    },
    now: () => time,
    randomSessionId: () => 'sessionid12345678'
  };
  return { deps, statuses, calls };
}

const OPTS: BrowserLoginOpts = {
  relayBase: 'https://relay.test',
  uiBase: 'https://ui.test',
  timeoutMs: 60_000
};

describe('runBrowserLogin', () => {
  it('completes the google flow', async () => {
    const { deps, statuses, calls } = makeFakes([
      { type: 'google' },
      { type: 'oidc-callback', callbackUrl: 'https://ui.test/login?s=sessionid12345678' }
    ]);
    const result = await runBrowserLogin(deps, OPTS);

    expect(result).toEqual({ walletAddress: '0xW', loginMethod: 'google' });
    expect(calls).toContain('announce:https://ui.test/login#sessionid12345678');
    expect(calls).toContain('startOidc:true:https://ui.test/login');
    expect(calls).toContain('completeOidc:https://ui.test/login?s=sessionid12345678');
    expect(statuses).toEqual([
      { status: 'auth-url', url: 'https://accounts.google.com/auth' },
      { status: 'done', walletAddress: '0xW' }
    ]);
  });

  it('completes the email flow', async () => {
    const { deps, statuses, calls } = makeFakes([
      { type: 'email', email: 'a@b.co' },
      { type: 'otp', code: '123456' }
    ]);
    const result = await runBrowserLogin(deps, OPTS);

    expect(result).toEqual({ walletAddress: '0xW', loginMethod: 'email' });
    expect(calls).toContain('startEmail:a@b.co');
    expect(calls).toContain('completeEmail:123456');
    expect(statuses).toEqual([{ status: 'otp-sent' }, { status: 'done', walletAddress: '0xW' }]);
  });

  it('publishes otp-invalid and accepts a retried code', async () => {
    const { deps, statuses } = makeFakes([
      { type: 'email', email: 'a@b.co' },
      { type: 'otp', code: 'BAD' },
      { type: 'otp', code: '123456' }
    ]);
    const result = await runBrowserLogin(deps, OPTS);

    expect(result.loginMethod).toBe('email');
    expect(statuses).toEqual([
      { status: 'otp-sent' },
      { status: 'otp-invalid', attemptsLeft: 2 },
      { status: 'done', walletAddress: '0xW' }
    ]);
  });

  it('fails after three bad codes', async () => {
    const { deps, statuses } = makeFakes([
      { type: 'email', email: 'a@b.co' },
      { type: 'otp', code: 'BAD' },
      { type: 'otp', code: 'BAD' },
      { type: 'otp', code: 'BAD' }
    ]);
    await expect(runBrowserLogin(deps, OPTS)).rejects.toThrow(/too many invalid codes/i);
    expect(statuses.at(-1)).toMatchObject({ status: 'error' });
  });

  it('throws when the user cancels on the page', async () => {
    const { deps, statuses } = makeFakes([{ type: 'cancel' }]);
    await expect(runBrowserLogin(deps, OPTS)).rejects.toThrow(/cancelled/i);
    expect(statuses.at(-1)).toMatchObject({ status: 'error' });
  });

  it('cancels while waiting for the oidc callback', async () => {
    const { deps, statuses } = makeFakes([{ type: 'google' }, { type: 'cancel' }]);
    await expect(runBrowserLogin(deps, OPTS)).rejects.toThrow(/cancelled/i);
    expect(statuses.at(-1)).toMatchObject({ status: 'error' });
  });

  it('times out when no action ever arrives', async () => {
    const { deps } = makeFakes([]);
    await expect(runBrowserLogin(deps, { ...OPTS, timeoutMs: 5000 })).rejects.toThrow(/timed out/i);
  });

  it('propagates a relay registration failure', async () => {
    const { deps } = makeFakes([]);
    deps.relay.registerSession = async () => {
      throw new Error('Relay register failed (503)');
    };
    await expect(runBrowserLogin(deps, OPTS)).rejects.toThrow(/Relay register failed/);
  });

  it('publishes an error status when the provider auth start fails', async () => {
    const { deps, statuses } = makeFakes([{ type: 'google' }]);
    deps.wallet.startOidcRedirectAuth = async () => {
      throw new Error('provider down');
    };
    await expect(runBrowserLogin(deps, OPTS)).rejects.toThrow(/provider down/);
    expect(statuses.at(-1)).toEqual({ status: 'error', message: 'provider down' });
  });

  it('publishes an error status when the relay action poll fails', async () => {
    const { deps, statuses } = makeFakes([]);
    deps.relay.nextAction = async () => {
      throw new Error('Relay poll failed (500)');
    };
    await expect(runBrowserLogin(deps, OPTS)).rejects.toThrow(/Relay poll failed/);
    expect(statuses.at(-1)).toEqual({ status: 'error', message: 'Relay poll failed (500)' });
  });
});

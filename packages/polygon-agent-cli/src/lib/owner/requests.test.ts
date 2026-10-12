// Owner requests through the browser method, against a fake OMS owner client
// and a scripted relay.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as OmsWallet from '@polygonlabs/oms-wallet';

import type { LoginAction, LoginStatus } from '../browser-login.ts';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-owner-requests-'));

const world = vi.hoisted(() => ({
  calls: [] as string[],
  // The signed-in account's wallets.
  wallets: [] as Array<{ id: string; address: string; keyOrigin: 'generated' | 'imported' }>
}));

vi.mock('@polygonlabs/oms-wallet', async (importOriginal) => {
  const real = await importOriginal<typeof OmsWallet>();

  class FakeOwnerWallet {
    walletAddress: string | undefined;
    credentialId = 'owner-cred';

    async startOidcRedirectAuth(p: { sessionLifetimeSeconds?: number; provider: unknown }) {
      world.calls.push(
        `startOidc:${p.sessionLifetimeSeconds}:${String(p.provider === real.OmsRelayOidcProviders.google)}`
      );
      return { authorizationUrl: 'https://accounts.google.com/auth' };
    }
    async completeOidcRedirectAuth(p: { callbackUrl: string; sessionLifetimeSeconds?: number }) {
      world.calls.push(`completeOidc:${p.sessionLifetimeSeconds}`);
      return this.signedIn();
    }
    async startEmailAuth(p: { email: string; sessionLifetimeSeconds?: number }) {
      world.calls.push(`startEmail:${p.email}:${p.sessionLifetimeSeconds}`);
    }
    async completeEmailAuth(p: { code: string }) {
      world.calls.push(`completeEmail:${p.code}`);
      return this.signedIn();
    }
    signedIn() {
      this.walletAddress = world.wallets[0]?.address;
      return {
        walletAddress: this.walletAddress,
        credential: { credentialId: this.credentialId }
      };
    }
    async listWallets() {
      return world.wallets;
    }
    async useWallet(p: { walletId: string }) {
      world.calls.push(`useWallet:${p.walletId}`);
      this.walletAddress = world.wallets.find((w) => w.id === p.walletId)?.address;
    }
    async revokeAccess(p: { credentialId: string }) {
      world.calls.push(`revoke:${p.credentialId}`);
    }
    async signOut() {
      world.calls.push('signOut');
    }
  }

  class FakeOMSWallet {
    wallet = new FakeOwnerWallet();
  }
  return { ...real, OMSWallet: FakeOMSWallet };
});

const { confirmOwnerRequest, loginPageUrl, startOwnerRequest } = await import('./requests.ts');
const { loadPending } = await import('./pending.ts');
const { saveOmsWalletPointer } = await import('../storage.ts');

const MAIN = '0xd384ea24ca0B3a5e4BB35935C611E3dCB68Fd08e';
const OTHER = '0x1111111111111111111111111111111111111111';
const NOW = new Date('2026-10-12T10:00:00.000Z');

let wallet: string;
let counter = 0;
let registered: unknown[];

beforeEach(() => {
  wallet = `w${++counter}`;
  world.calls = [];
  world.wallets = [{ id: 'w-main', address: MAIN, keyOrigin: 'generated' }];
  registered = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/api/login/register')) {
        registered.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      }
      return Response.json({ error: 'unexpected', url }, { status: 500 });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function startBrowser() {
  return startOwnerRequest({
    wallet,
    method: 'browser',
    context: { purpose: 'access' },
    action: { kind: 'access' },
    now: NOW
  });
}

// A relay that hands out the scripted actions (null = nothing yet), and a
// clock that the poll sleep moves forward.
function fakeDeps(actions: Array<LoginAction | null>) {
  const statuses: LoginStatus[] = [];
  const sessions: string[] = [];
  let time = NOW.getTime();
  return {
    statuses,
    sessions,
    deps: {
      relay: {
        registerSession: async () => {
          throw new Error('the request registered its session already');
        },
        nextAction: async (session: string) => {
          sessions.push(session);
          return actions.length > 0 ? (actions.shift() ?? null) : null;
        },
        setStatus: async (_session: string, status: LoginStatus) => {
          statuses.push(status);
        }
      },
      sleep: async (ms: number) => {
        time += ms;
      },
      now: () => time
    }
  };
}

const GOOGLE_DONE: LoginAction[] = [
  { type: 'google' },
  { type: 'oidc-callback', callbackUrl: 'https://ui.test/login?code=1' }
];

describe('startOwnerRequest (browser)', () => {
  it('registers the relay session with the context and saves a browser request', async () => {
    const request = await startBrowser();
    expect(request.method).toBe('browser');
    if (request.method !== 'browser') throw new Error('unreachable');
    expect(registered).toEqual([{ session: request.relaySession, context: { purpose: 'access' } }]);
    expect(loadPending(wallet)).toEqual(request);
    expect(request.expiresAt).toBe('2026-10-12T10:10:00.000Z');
    expect(world.calls.some((c) => c.startsWith('startEmail'))).toBe(false);
  });

  it('gives the login page url for the session', () => {
    expect(loginPageUrl('abc')).toMatch(/\/login#abc$/);
  });
});

describe('confirmOwnerRequest (browser)', () => {
  it('signs in, deletes the pending file, runs the action and revokes', async () => {
    const request = await startBrowser();
    const { deps, statuses, sessions } = fakeDeps([...GOOGLE_DONE]);
    const pendingDuringRun: unknown[] = [];
    const result = await confirmOwnerRequest({
      wallet,
      requestId: request.id,
      now: NOW,
      browser: { deps, timeoutMs: 60_000 },
      run: async (context) => {
        pendingDuringRun.push(loadPending(wallet));
        return { walletAddress: context.walletAddress };
      }
    });
    expect(result).toEqual({ walletAddress: MAIN, ownerSignInRevoked: true });
    expect(pendingDuringRun).toEqual([null]);
    expect(request.method === 'browser' && sessions.every((s) => s === request.relaySession)).toBe(
      true
    );
    expect(statuses).toContainEqual({ status: 'done', walletAddress: MAIN });
    expect(world.calls).toEqual([
      'startOidc:600:true',
      'completeOidc:600',
      'revoke:owner-cred',
      'signOut'
    ]);
  });

  it('passes the short owner lifetime to an email sign-in on the page', async () => {
    const request = await startBrowser();
    const { deps } = fakeDeps([
      { type: 'email', email: 'o@example.com' },
      { type: 'otp', code: '123456' }
    ]);
    await confirmOwnerRequest({
      wallet,
      requestId: request.id,
      now: NOW,
      browser: { deps, timeoutMs: 60_000 },
      run: async () => ({})
    });
    expect(world.calls.slice(0, 2)).toEqual([
      'startEmail:o@example.com:600',
      'completeEmail:123456'
    ]);
  });

  it('cancel on the page: an error, the pending file deleted, nothing run', async () => {
    const request = await startBrowser();
    const { deps } = fakeDeps([{ type: 'cancel' }]);
    const run = vi.fn(async () => ({}));
    await expect(
      confirmOwnerRequest({
        wallet,
        requestId: request.id,
        now: NOW,
        browser: { deps, timeoutMs: 60_000 },
        run
      })
    ).rejects.toMatchObject({ code: 'request_cancelled' });
    expect(run).not.toHaveBeenCalled();
    expect(loadPending(wallet)).toBeNull();
  });

  it('times out with request_expired', async () => {
    const request = await startBrowser();
    const { deps } = fakeDeps([]);
    const run = vi.fn(async () => ({}));
    await expect(
      confirmOwnerRequest({
        wallet,
        requestId: request.id,
        now: NOW,
        browser: { deps, timeoutMs: 10_000 },
        run
      })
    ).rejects.toMatchObject({ code: 'request_expired' });
    expect(run).not.toHaveBeenCalled();
    expect(loadPending(wallet)).toBeNull();
  });

  it('stops waiting when the request expires, even with a longer timeout', async () => {
    const request = await startBrowser();
    const { deps } = fakeDeps([]);
    const later = new Date(NOW.getTime() + 9 * 60 * 1000);
    let time = later.getTime();
    await expect(
      confirmOwnerRequest({
        wallet,
        requestId: request.id,
        now: later,
        browser: {
          deps: {
            ...deps,
            sleep: async (ms: number) => {
              time += ms;
            },
            now: () => time
          },
          timeoutMs: 60 * 60 * 1000
        },
        run: async () => ({})
      })
    ).rejects.toMatchObject({ code: 'request_expired' });
    expect(time).toBeLessThanOrEqual(Date.parse(request.expiresAt) + 2000);
  });

  it('a different account than the install wallet: the wrong-account error, still revoked', async () => {
    await saveOmsWalletPointer(wallet, {
      walletAddress: OTHER,
      loginMethod: 'email',
      createdAt: NOW.toISOString()
    });
    const request = await startBrowser();
    const { deps, statuses } = fakeDeps([...GOOGLE_DONE]);
    const run = vi.fn(async () => ({}));
    const error = await confirmOwnerRequest({
      wallet,
      requestId: request.id,
      now: NOW,
      browser: { deps, timeoutMs: 60_000 },
      run
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'invalid_input',
      message: `That code signed in to ${MAIN}, not this install's wallet ${OTHER}. Use the email the wallet was created with.`,
      details: { ownerSignInRevoked: true }
    });
    expect(run).not.toHaveBeenCalled();
    expect(loadPending(wallet)).toBeNull();
    expect(world.calls).toContain('revoke:owner-cred');
    expect(statuses.at(-1)).toMatchObject({ status: 'error' });
  });

  it('refuses a code for a browser request, keeping it', async () => {
    const request = await startBrowser();
    await expect(
      confirmOwnerRequest({
        wallet,
        requestId: request.id,
        now: NOW,
        code: '123456',
        run: async () => ({})
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(loadPending(wallet)?.id).toBe(request.id);
  });
});

// Owner requests end to end through the command handlers, against a fake OMS
// that keeps sessions per credential like the real service.

import type { CommandModule } from 'yargs';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as OmsWallet from '@polygonlabs/oms-wallet';

import { OMSWalletRequestError } from '@polygonlabs/oms-wallet';

import type * as Prices from '../lib/prices.ts';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-owner-flow-'));

interface FakeSession {
  credentialId: string;
  chainId: number;
  grants: readonly OmsWallet.SmartSessionGrant[];
  expiresAt: string;
}

const world = vi.hoisted(() => ({
  sessions: new Map<string, FakeSession>(),
  revoked: new Set<string>(),
  ownerCredentials: new Set<string>(),
  calls: [] as string[],
  failChains: new Set<number>(),
  unsponsored: new Set<number>(),
  failOwnerRevoke: false,
  nextSession: 0,
  code: '123456',
  // Approve something other than what was asked (OMS misbehaving).
  tamper: false,
  // The session key's reads fail, e.g. an outage.
  listSessionsError: undefined as unknown,
  racRevokeError: undefined as unknown,
  walletAddress: '0xd384ea24ca0B3a5e4BB35935C611E3dCB68Fd08e',
  isPending: (): boolean => false,
  pendingDuringRun: [] as boolean[],
  sent: [] as Array<{ to: string; data: string; network: number }>
}));

const httpError = (status: number, name?: string) =>
  new OMSWalletRequestError({
    code: 'OMS_HTTP_ERROR',
    message: name ?? `HTTP ${status}`,
    status,
    upstreamError: { service: 'waas', status, ...(name ? { name } : {}) }
  });

vi.mock('@polygonlabs/oms-wallet', async (importOriginal) => {
  const real = await importOriginal<typeof OmsWallet>();

  class FakeOwnerWallet {
    activeEmailAuthAttempt?: {
      email: string;
      verifier: string;
      challenge: string;
      sessionLifetimeSeconds: number;
    };
    credentialId = `owner-${Math.random()}`;

    async startEmailAuth(params: { email: string; sessionLifetimeSeconds: number }) {
      world.calls.push(`startEmailAuth:${params.sessionLifetimeSeconds}`);
      this.activeEmailAuthAttempt = {
        email: params.email,
        verifier: 'v-1',
        challenge: 'c-1',
        sessionLifetimeSeconds: params.sessionLifetimeSeconds
      };
    }
    async completeEmailAuth(params: { code: string }) {
      if (this.activeEmailAuthAttempt?.verifier !== 'v-1')
        throw new Error('No pending email auth attempt');
      if (params.code !== world.code) throw httpError(400, 'AnswerIncorrect');
      world.ownerCredentials.add(this.credentialId);
      world.calls.push('signedIn');
      return {
        walletAddress: world.walletAddress,
        credential: { credentialId: this.credentialId }
      };
    }
    async authorizeRemoteAccess(params: {
      credentialId: string;
      network: { id: number };
      grants: readonly OmsWallet.SmartSessionGrant[];
      expiresAt: string;
      sessionId?: string;
    }) {
      world.calls.push(
        `authorize:${params.network.id}${params.sessionId ? `:${params.sessionId}` : ''}`
      );
      world.pendingDuringRun.push(world.isPending());
      if (world.failChains.has(params.network.id)) throw httpError(500);
      const sessionId = params.sessionId ?? `sess-${params.network.id}-${++world.nextSession}`;
      world.sessions.set(sessionId, {
        credentialId: params.credentialId,
        chainId: params.network.id,
        grants: world.tamper
          ? params.grants.map((g) => ({ ...g, limit: g.limit * 2n }))
          : params.grants,
        expiresAt: params.expiresAt
      });
      return { walletId: 'wal-1', sessionId, expiresAt: params.expiresAt };
    }
    async revokeAccess(params: { credentialId: string; sessionId?: string }) {
      world.calls.push(
        `revokeAccess:${params.sessionId ? 'session' : world.ownerCredentials.has(params.credentialId) ? 'owner' : 'credential'}`
      );
      if (params.sessionId) {
        world.sessions.delete(params.sessionId);
        return;
      }
      if (world.ownerCredentials.has(params.credentialId) && world.failOwnerRevoke)
        throw httpError(503);
      world.revoked.add(params.credentialId);
    }
    async listAccess() {
      world.calls.push('listAccess');
      return [{ type: 'direct', credentialId: this.credentialId, expiresAt: '', isCaller: true }];
    }
    async sendTransaction(params: { to: string; data: string; network: { id: number } }) {
      world.calls.push('sendTransaction');
      world.sent.push({ to: params.to, data: params.data, network: params.network.id });
      return { txnHash: '0xwithdraw' };
    }
    async signOut() {}
  }

  class FakeOMSWallet {
    wallet = new FakeOwnerWallet();
    indexer = { getBalances: async () => ({ status: 200, nativeBalances: [], balances: [] }) };
  }

  class FakeRemoteAccessClient {
    signer: OmsWallet.CredentialSigner;
    constructor(params: { credentialSigner: OmsWallet.CredentialSigner }) {
      this.signer = params.credentialSigner;
    }
    async id() {
      return `rac-${await this.signer.credentialId()}`;
    }
    async registerCredential() {
      world.calls.push('registerCredential');
      return { credentialId: await this.id() };
    }
    async revokeCredential(params: { credentialId: string }) {
      world.calls.push('revokeCredential');
      if (world.racRevokeError) throw world.racRevokeError;
      world.revoked.add(params.credentialId);
    }
    async listSessions() {
      if (world.listSessionsError) throw world.listSessionsError;
      const id = await this.id();
      if (world.revoked.has(id)) throw httpError(401);
      return [...world.sessions.entries()]
        .filter(([, s]) => s.credentialId === id)
        .map(([sessionId, s]) => ({
          sessionId,
          walletId: 'wal-1',
          signerAddress: '0x0',
          chainId: s.chainId,
          expiresAt: s.expiresAt,
          grants: s.grants
        }));
    }
    async getSessionUsage(params: { sessionId: string }) {
      return (world.sessions.get(params.sessionId)?.grants ?? []).map((grant) => ({
        grant,
        used: 0n
      }));
    }
    async prepareTransaction(params: { network: { id: number } }) {
      world.calls.push(`prepare:${params.network.id}`);
      return {
        txnId: 't',
        status: 'quoted',
        feeOptions: [],
        sponsored: !world.unsponsored.has(params.network.id),
        expiresAt: ''
      };
    }
    async executeTransaction() {
      world.calls.push('execute');
      return { status: 'pending' };
    }
  }

  return { ...real, OMSWallet: FakeOMSWallet, RemoteAccessClient: FakeRemoteAccessClient };
});

vi.mock('../lib/prices.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Prices>()),
  getUsdPrices: async (tokens: Array<{ chainId: number; address: string }>) =>
    new Map(tokens.map((t) => [`${t.chainId}:${t.address.toLowerCase()}`, 2500]))
}));

const {
  accessCommandModule,
  allowanceCommandModule,
  confirmCommandModule,
  handleEmailLogin,
  logoutSessionWallet,
  withdrawCommandModule
} = await import('./wallet-session.ts');
const { loadPending, savePending } = await import('../lib/owner/pending.ts');
const { readApprovedPlan } = await import('../lib/session/state.ts');
const { readRacRecord } = await import('../lib/session/rac.ts');
const { loadOmsWalletPointer } = await import('../lib/storage.ts');

let wallet: string;
let counter = 0;

function lastJson(spy: 'log' | 'error'): Record<string, unknown> {
  const calls = vi.mocked(console[spy]).mock.calls;
  return JSON.parse(String(calls.at(-1)?.[0]));
}

async function connectStep1(args: { chains?: string } = {}): Promise<string> {
  await handleEmailLogin({
    name: wallet,
    email: 'owner@example.com',
    allowance: 500,
    days: 7,
    chains: args.chains ?? 'polygon,base'
  });
  const out = lastJson('log');
  expect(out).toMatchObject({ ok: true, status: 'code_sent', action: 'connect' });
  return String(out.request);
}

async function confirm(request: string, code = world.code): Promise<Record<string, unknown>> {
  if (typeof confirmCommandModule.handler !== 'function') throw new Error('no handler');
  vi.mocked(console.log).mockClear();
  vi.mocked(console.error).mockClear();
  try {
    await confirmCommandModule.handler({ _: [], $0: 'polygon-agent', name: wallet, request, code });
    return lastJson('log');
  } catch {
    // Failures print to stderr; a result with ok: false prints to stdout, then exits.
    return vi.mocked(console.error).mock.calls.length > 0 ? lastJson('error') : lastJson('log');
  }
}

beforeEach(() => {
  wallet = `flow${++counter}`;
  world.sessions.clear();
  world.revoked.clear();
  world.calls.length = 0;
  world.failChains.clear();
  world.unsponsored.clear();
  world.failOwnerRevoke = false;
  world.tamper = false;
  world.listSessionsError = undefined;
  world.racRevokeError = undefined;
  world.walletAddress = '0xd384ea24ca0B3a5e4BB35935C611E3dCB68Fd08e';
  world.isPending = () =>
    fs.existsSync(path.join(String(process.env.POLYGON_AGENT_HOME), 'pending', `${wallet}.json`));
  world.pendingDuringRun.length = 0;
  world.sent.length = 0;
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

describe('connect', () => {
  it('step 1 registers the session key, asks for a short sign-in, and shows the plan', async () => {
    const request = await connectStep1();
    const out = lastJson('log');
    expect(out.next).toBe(
      `polygon-agent wallet confirm --request ${request} --code <code> --name ${wallet}`
    );
    expect(JSON.stringify(out.plan)).toContain('Spend up to $500 in total');
    expect(world.calls).toEqual(['registerCredential', 'startEmailAuth:600']);
    expect(readRacRecord({ wallet, slot: 'rac' })?.installName).toBeTruthy();
    expect(loadPending(wallet)?.id).toBe(request);
  });

  it('step 2 approves each chain, verifies, probes gas, saves, and revokes the sign-in', async () => {
    const request = await connectStep1();
    const out = await confirm(request);
    expect(out).toMatchObject({
      ok: true,
      action: 'connect',
      connected: true,
      ownerSignInRevoked: true,
      failed: []
    });
    expect(world.calls).toEqual([
      'registerCredential',
      'startEmailAuth:600',
      'signedIn',
      'authorize:137',
      'authorize:8453',
      'prepare:137',
      'prepare:8453',
      'revokeAccess:owner'
    ]);
    expect(world.calls).not.toContain('execute');
    const approved = readApprovedPlan(wallet);
    expect(approved?.plan.chains.map((c) => [c.chainId, c.sessionId])).toEqual([
      [137, expect.stringMatching(/^sess-137-/)],
      [8453, expect.stringMatching(/^sess-8453-/)]
    ]);
    expect(await loadOmsWalletPointer(wallet)).toMatchObject({
      access: 'session',
      loginMethod: 'email',
      email: 'owner@example.com'
    });
    expect(loadPending(wallet)).toBeNull();
    expect(String(out.worstCase)).toContain('$500');
  });

  it('a wrong code keeps the request; the right code then works', async () => {
    const request = await connectStep1();
    expect(await confirm(request, '000000')).toMatchObject({ ok: false, code: 'invalid_code' });
    expect(loadPending(wallet)?.id).toBe(request);
    expect(await confirm(request)).toMatchObject({ ok: true, connected: true });
  });

  it('an expired request is refused and removed, without signing in', async () => {
    const request = await connectStep1();
    const pending = loadPending(wallet);
    if (!pending) throw new Error('no pending request');
    savePending({ ...pending, expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(await confirm(request)).toMatchObject({ ok: false, code: 'request_expired' });
    expect(loadPending(wallet)).toBeNull();
    expect(world.calls).not.toContain('signedIn');
  });

  it('a chain that fails to approve is reported; the rest are saved', async () => {
    world.failChains.add(8453);
    const out = await confirm(await connectStep1());
    expect(out).toMatchObject({ ok: true, connected: true });
    expect(out.failed).toEqual([
      expect.objectContaining({ chainId: 8453, code: 'upstream_unavailable' })
    ]);
    expect(readApprovedPlan(wallet)?.plan.chains.map((c) => c.chainId)).toEqual([137]);
  });

  it('an unsponsored chain is revoked while signed in and left out', async () => {
    world.unsponsored.add(8453);
    const out = await confirm(await connectStep1());
    expect(out.failed).toEqual([expect.objectContaining({ chainId: 8453, code: 'not_sponsored' })]);
    expect(world.calls.filter((c) => c.startsWith('revokeAccess'))).toEqual([
      'revokeAccess:session',
      'revokeAccess:owner'
    ]);
    expect(world.calls.indexOf('revokeAccess:session')).toBeLessThan(
      world.calls.indexOf('revokeAccess:owner')
    );
    expect(readApprovedPlan(wallet)?.plan.chains.map((c) => c.chainId)).toEqual([137]);
  });

  it('reports a failed sign-in revoke instead of hiding it', async () => {
    world.failOwnerRevoke = true;
    const out = await confirm(await connectStep1());
    expect(out).toMatchObject({ ok: true, connected: true, ownerSignInRevoked: false });
    expect(String(out.ownerSignInRevokeError)).toMatch(/503/);
  });

  it('refuses a second connect while sessions are live', async () => {
    await confirm(await connectStep1());
    await expect(
      handleEmailLogin({ name: wallet, email: 'owner@example.com', chains: 'polygon' })
    ).rejects.toThrow('CLI exited');
    expect(lastJson('error')).toMatchObject({ code: 'already_connected' });
  });
});

describe('allowance set and renew', () => {
  async function run(argv: string[]) {
    const yargs = (await import('yargs')).default;
    vi.mocked(console.log).mockClear();
    await yargs()
      .command(allowanceCommandModule)
      .parseAsync(['allowance', ...argv, '--name', wallet]);
    return lastJson('log');
  }

  it('set re-approves existing sessions by id and creates new chains', async () => {
    await confirm(await connectStep1({ chains: 'polygon' }));
    const sessionId = readApprovedPlan(wallet)?.plan.chains[0].sessionId;
    world.calls.length = 0;
    const step1 = await run(['set', '--amount', '800', '--chains', 'arbitrum']);
    expect(step1).toMatchObject({
      status: 'code_sent',
      action: 'allowance-set',
      previousAllowanceUsd: 500
    });
    const out = await confirm(String(step1.request));
    expect(out).toMatchObject({ ok: true, updated: true });
    expect(world.calls).toContain(`authorize:137:${sessionId}`);
    expect(world.calls).toContain('authorize:42161');
    // Only the new chain is probed for gas.
    expect(world.calls.filter((c) => c.startsWith('prepare'))).toEqual(['prepare:42161']);
    const plan = readApprovedPlan(wallet)?.plan;
    expect(plan?.allowanceUsd).toBe(800);
    expect(plan?.chains.map((c) => c.chainId)).toEqual([137, 42161]);
  });

  it('renew moves the sessions to a new key and revokes the old one', async () => {
    await confirm(await connectStep1({ chains: 'polygon' }));
    const oldKey = readRacRecord({ wallet, slot: 'rac' })?.credentialId;
    const step1 = await run(['renew', '--days', '14']);
    expect(readRacRecord({ wallet, slot: 'rac-next' })).not.toBeNull();
    const out = await confirm(String(step1.request));
    expect(out).toMatchObject({ ok: true, renewed: true });
    const newKey = readRacRecord({ wallet, slot: 'rac' })?.credentialId;
    expect(newKey).not.toBe(oldKey);
    expect(world.revoked.has(String(oldKey))).toBe(true);
    expect(readRacRecord({ wallet, slot: 'rac-next' })).toBeNull();
    expect(readApprovedPlan(wallet)?.plan.days).toBe(14);
  });
});

describe('logout', () => {
  it('revokes the session key on OMS, then removes local state', async () => {
    await confirm(await connectStep1({ chains: 'polygon' }));
    const key = readRacRecord({ wallet, slot: 'rac' })?.credentialId;
    expect(await logoutSessionWallet(wallet)).toMatchObject({ accessRevoked: true });
    expect(world.revoked.has(String(key))).toBe(true);
    expect(await loadOmsWalletPointer(wallet)).toBeNull();
  });
});

describe('owner-request safety', () => {
  async function yargsRun<U>(module: CommandModule<object, U>, argv: string[]) {
    const yargs = (await import('yargs')).default;
    vi.mocked(console.log).mockClear();
    vi.mocked(console.error).mockClear();
    try {
      await yargs().command(module).parseAsync(argv);
    } catch {
      // process.exit is mocked to throw
    }
  }

  it('deletes the sign-in key from disk as soon as the code is accepted', async () => {
    const request = await connectStep1();
    expect(world.isPending()).toBe(true);
    await confirm(request);
    expect(world.pendingDuringRun.length).toBeGreaterThan(0);
    expect(world.pendingDuringRun.every((pending) => !pending)).toBe(true);
  });

  it('keeps the pending request encrypted and owner-only', async () => {
    await connectStep1();
    const file = path.join(String(process.env.POLYGON_AGENT_HOME), 'pending', `${wallet}.json`);
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain(String(loadPending(wallet)?.ownerKey));
    expect(raw).not.toContain('owner@example.com');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses a code that signs in to a different wallet, and still revokes the sign-in', async () => {
    await confirm(await connectStep1({ chains: 'polygon' }));
    await yargsRun(allowanceCommandModule, [
      'allowance',
      'set',
      '--amount',
      '900',
      '--name',
      wallet
    ]);
    const request = String(lastJson('log').request);
    world.walletAddress = '0x1111111111111111111111111111111111111111';
    world.calls.length = 0;
    const out = await confirm(request);
    expect(out).toMatchObject({ ok: false, code: 'invalid_input', ownerSignInRevoked: true });
    expect(world.calls).toContain('revokeAccess:owner');
    expect(world.calls.some((c) => c.startsWith('authorize'))).toBe(false);
    expect(readApprovedPlan(wallet)?.plan.allowanceUsd).toBe(500);
  });

  it('revokes a session that differs from the plan in any way', async () => {
    world.tamper = true;
    const out = await confirm(await connectStep1());
    expect(out).toMatchObject({ ok: false, connected: false });
    expect(world.calls.filter((c) => c === 'revokeAccess:session')).toHaveLength(2);
    expect(world.sessions.size).toBe(0);
    expect(await loadOmsWalletPointer(wallet)).toBeNull();
  });

  it('revokes every approved session if they cannot be read back', async () => {
    const request = await connectStep1();
    world.listSessionsError = httpError(500);
    const out = await confirm(request);
    expect(out).toMatchObject({
      ok: false,
      code: 'upstream_unavailable',
      ownerSignInRevoked: true
    });
    expect(world.sessions.size).toBe(0);
    expect(await loadOmsWalletPointer(wallet)).toBeNull();
  });

  it('an outage during the already-connected check fails instead of revoking a working key', async () => {
    await confirm(await connectStep1({ chains: 'polygon' }));
    const key = readRacRecord({ wallet, slot: 'rac' })?.credentialId;
    world.listSessionsError = httpError(503);
    world.calls.length = 0;
    await expect(
      handleEmailLogin({ name: wallet, email: 'owner@example.com', chains: 'polygon' })
    ).rejects.toThrow('CLI exited');
    expect(lastJson('error')).toMatchObject({ code: 'upstream_unavailable' });
    expect(world.calls).not.toContain('revokeCredential');
    expect(readRacRecord({ wallet, slot: 'rac' })?.credentialId).toBe(key);
  });

  it('an allowance change with nothing approved changes nothing', async () => {
    await confirm(await connectStep1({ chains: 'polygon' }));
    await yargsRun(allowanceCommandModule, [
      'allowance',
      'set',
      '--amount',
      '900',
      '--name',
      wallet
    ]);
    world.failChains.add(137);
    const out = await confirm(String(lastJson('log').request));
    expect(out).toMatchObject({ ok: false, updated: false });
    expect(readApprovedPlan(wallet)?.plan.allowanceUsd).toBe(500);
  });

  it('withdraw sends exactly the transfer shown in step 1, as the owner', async () => {
    await confirm(await connectStep1({ chains: 'polygon' }));
    const to = '0x1D17C0F90A0b3dFb5124C2FF56B33a0D2E202e1d';
    await yargsRun(withdrawCommandModule, [
      'withdraw',
      '--to',
      to,
      '--token',
      'USDC',
      '--amount',
      '1.5',
      '--name',
      wallet
    ]);
    const step1 = lastJson('log');
    expect(step1).toMatchObject({
      action: 'withdraw',
      withdraw: { amount: '1.5', token: 'USDC', to }
    });
    const out = await confirm(String(step1.request));
    expect(out).toMatchObject({
      ok: true,
      withdrawn: true,
      txHash: '0xwithdraw',
      ownerSignInRevoked: true
    });
    const { decodeFunctionData, erc20Abi } = await import('viem');
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]).toMatchObject({
      to: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      network: 137
    });
    expect(
      decodeFunctionData({ abi: erc20Abi, data: world.sent[0].data as `0x${string}` }).args
    ).toEqual([to, 1_500_000n]);
  });

  it('access lists who has access, marking this sign-in', async () => {
    await confirm(await connectStep1({ chains: 'polygon' }));
    await yargsRun(accessCommandModule, ['access', '--name', wallet]);
    const out = await confirm(String(lastJson('log').request));
    expect(out).toMatchObject({ ok: true, action: 'access' });
    expect(out.access).toEqual([expect.objectContaining({ type: 'direct', isThisSignIn: true })]);
  });
});

describe('logout and removal of a session wallet', () => {
  it('counts a key OMS already rejects (401) as revoked', async () => {
    await confirm(await connectStep1({ chains: 'polygon' }));
    world.racRevokeError = httpError(401);
    expect(await logoutSessionWallet(wallet)).toMatchObject({ accessRevoked: true });
    expect(await loadOmsWalletPointer(wallet)).toBeNull();
  });

  it('keeps everything when OMS is unavailable, so logout can be retried', async () => {
    await confirm(await connectStep1({ chains: 'polygon' }));
    world.racRevokeError = httpError(503);
    await expect(logoutSessionWallet(wallet)).rejects.toMatchObject({
      code: 'upstream_unavailable'
    });
    expect(await loadOmsWalletPointer(wallet)).not.toBeNull();
    expect(readRacRecord({ wallet, slot: 'rac' })).not.toBeNull();
  });

  it('wallet remove refuses a session wallet instead of leaving its access live', async () => {
    await confirm(await connectStep1({ chains: 'polygon' }));
    const { walletCommand } = await import('./wallet.ts');
    const yargs = (await import('yargs')).default;
    await yargs()
      .command(walletCommand)
      .parseAsync(['wallet', 'remove', '--name', wallet])
      .catch(() => undefined);
    const errors = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .filter((line) => line.startsWith('{'));
    expect(JSON.parse(errors[0])).toMatchObject({ code: 'invalid_input' });
    expect(await loadOmsWalletPointer(wallet)).not.toBeNull();
  });
});

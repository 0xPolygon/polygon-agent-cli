import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-owner-actions-'));

const m = vi.hoisted(() => ({
  step: vi.fn(),
  retire: vi.fn(),
  enroll: vi.fn(),
  records: {} as Record<string, { credentialId: string; expiresAt: string } | undefined>
}));
vi.mock('../polymarket/owner-step.ts', () => ({ polymarketOwnerStep: m.step }));
vi.mock('../credentials/agent.ts', () => ({ enrollAgent: m.enroll }));
vi.mock('../session/rac.ts', async (o) => ({
  ...(await o<Record<string, unknown>>()),
  retireParkedRacs: m.retire,
  readRacRecord: ({ slot }: { slot: string }) => m.records[slot] ?? null,
  parkedRacSlots: () => Object.keys(m.records).filter((slot) => slot.startsWith('retiring-'))
}));

const { runOwnerAction } = await import('./actions.ts');

const ownerWallet = { listAccess: vi.fn(async () => []) };
const context = {
  owner: { wallet: ownerWallet },
  walletAddress: '0xMAIN',
  request: { action: { kind: 'access' } }
} as never;

const LINKED = { enrolled: true, expiresAt: '2026-11-11T00:00:00.000Z', renewed: false };
m.enroll.mockResolvedValue(LINKED);

describe('runOwnerAction polymarket step', () => {
  it('passes the owner client, wallet and main address and adds the result', async () => {
    m.retire.mockResolvedValue([]);
    m.step.mockResolvedValue({ backedUp: true, omsWalletId: 'w1' });
    const out = await runOwnerAction({ context, wallet: 'main', now: new Date() });
    expect(m.step).toHaveBeenCalledWith({
      wallet: 'main',
      owner: ownerWallet,
      mainAddress: '0xMAIN',
      // A request's sign-in ends with it.
      signsWithOms: false
    });
    expect(out).toEqual({
      action: 'access',
      access: [],
      credentials: LINKED,
      polymarket: { backedUp: true, omsWalletId: 'w1' }
    });
  });

  it('a throwing step leaves the action result unchanged apart from polymarket.backedUp false', async () => {
    m.retire.mockResolvedValue([]);
    m.step.mockRejectedValue(new Error('kaboom'));
    const out = await runOwnerAction({ context, wallet: 'main', now: new Date() });
    expect(out).toEqual({
      action: 'access',
      access: [],
      credentials: LINKED,
      polymarket: { backedUp: false, error: 'kaboom' }
    });
  });

  it('keeps keysPendingRevocation alongside polymarket', async () => {
    m.retire.mockResolvedValue(['k1']);
    m.step.mockResolvedValue({ backedUp: true });
    const out = await runOwnerAction({ context, wallet: 'main', now: new Date() });
    expect(out.keysPendingRevocation).toEqual(['k1']);
    expect(out.polymarket).toEqual({ backedUp: true });
  });
});

describe('runOwnerAction credentials link', () => {
  it('links the agent key before the Polymarket step, as the main wallet', async () => {
    m.retire.mockResolvedValue([]);
    m.step.mockResolvedValue({ backedUp: true });
    const order: string[] = [];
    m.enroll.mockImplementationOnce(async () => (order.push('enroll'), LINKED));
    m.step.mockImplementationOnce(async () => (order.push('polymarket'), { backedUp: true }));
    await runOwnerAction({ context, wallet: 'main', now: new Date() });
    expect(order).toEqual(['enroll', 'polymarket']);
    expect(m.enroll).toHaveBeenLastCalledWith({
      wallet: 'main',
      owner: ownerWallet,
      walletAddress: '0xMAIN',
      force: false
    });
  });

  it('forces a fresh link for a link-credentials request', async () => {
    m.retire.mockResolvedValue([]);
    m.step.mockResolvedValue({ backedUp: true });
    const linkContext = {
      ...(context as object),
      request: { action: { kind: 'link-credentials' } }
    } as never;
    const out = await runOwnerAction({ context: linkContext, wallet: 'main', now: new Date() });
    expect(out.action).toBe('link-credentials');
    expect(m.enroll).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }));
  });
});

describe('runOwnerAction keeping the sign-in', () => {
  it("revokes the install's live session keys, drops the session records and signs it in", async () => {
    const { saveOmsWalletPointer, loadOmsWalletPointer } = await import('../storage.ts');
    const { sessionDir, hasSessionState } = await import('../session/state.ts');
    await saveOmsWalletPointer('kept', {
      walletAddress: '0xMAIN',
      loginMethod: 'email',
      createdAt: 'x',
      access: 'session',
      email: 'o@example.com'
    });
    sessionDir('kept');
    const now = new Date('2026-10-14T10:00:00.000Z');
    m.records = {
      rac: { credentialId: 'cred-live', expiresAt: '2026-11-01T00:00:00.000Z' },
      'rac-next': { credentialId: 'cred-old', expiresAt: '2026-10-01T00:00:00.000Z' },
      'retiring-x': { credentialId: 'cred-parked', expiresAt: '2026-11-01T00:00:00.000Z' }
    };
    m.retire.mockResolvedValue([]);
    m.step.mockResolvedValue({ backedUp: true, restored: true });
    const revokeAccess = vi.fn(async () => undefined);
    const out = await runOwnerAction({
      context: {
        owner: { wallet: { revokeAccess } },
        walletAddress: '0xMAIN',
        request: { method: 'email', email: 'o@example.com', action: { kind: 'owner' } }
      } as never,
      wallet: 'kept',
      now
    });
    // An expired key has no access left to revoke.
    expect(revokeAccess.mock.calls).toEqual([
      [{ credentialId: 'cred-live' }],
      [{ credentialId: 'cred-parked' }]
    ]);
    expect(hasSessionState('kept')).toBe(false);
    const pointer = await loadOmsWalletPointer('kept');
    expect(pointer).toMatchObject({ walletAddress: '0xMAIN', email: 'o@example.com' });
    expect(pointer?.access).toBeUndefined();
    expect(m.step).toHaveBeenCalledWith(
      expect.objectContaining({ wallet: 'kept', signsWithOms: true })
    );
    expect(out).toMatchObject({
      action: 'owner',
      signedIn: true,
      revokedSessionKeys: 3,
      polymarket: { restored: true }
    });
    m.records = {};
  });

  it('changes nothing locally when a revoke fails', async () => {
    const { saveOmsWalletPointer, loadOmsWalletPointer } = await import('../storage.ts');
    const { sessionDir, hasSessionState } = await import('../session/state.ts');
    await saveOmsWalletPointer('kept2', {
      walletAddress: '0xMAIN',
      loginMethod: 'email',
      createdAt: 'x',
      access: 'session'
    });
    sessionDir('kept2');
    m.records = { rac: { credentialId: 'cred-live', expiresAt: '2099-01-01T00:00:00.000Z' } };
    await expect(
      runOwnerAction({
        context: {
          owner: {
            wallet: { revokeAccess: vi.fn(async () => Promise.reject(new Error('oms down'))) }
          },
          walletAddress: '0xMAIN',
          request: { method: 'browser', action: { kind: 'owner' } }
        } as never,
        wallet: 'kept2',
        now: new Date()
      })
    ).rejects.toThrow('oms down');
    expect(hasSessionState('kept2')).toBe(true);
    expect((await loadOmsWalletPointer('kept2'))?.access).toBe('session');
    m.records = {};
  });
});

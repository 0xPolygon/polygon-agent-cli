import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-owner-actions-'));

const m = vi.hoisted(() => ({ step: vi.fn(), retire: vi.fn(), enroll: vi.fn() }));
vi.mock('../polymarket/owner-step.ts', () => ({ polymarketOwnerStep: m.step }));
vi.mock('../credentials/agent.ts', () => ({ enrollAgent: m.enroll }));
vi.mock('../session/rac.ts', async (o) => ({
  ...(await o<Record<string, unknown>>()),
  retireParkedRacs: m.retire
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
      mainAddress: '0xMAIN'
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

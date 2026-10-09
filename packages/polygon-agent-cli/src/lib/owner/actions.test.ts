import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-owner-actions-'));

const m = vi.hoisted(() => ({ step: vi.fn(), retire: vi.fn() }));
vi.mock('../polymarket/owner-step.ts', () => ({ polymarketOwnerStep: m.step }));
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

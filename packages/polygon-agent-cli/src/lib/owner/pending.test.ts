import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-owner-pending-'));

const { loadPending, savePending } = await import('./pending.ts');
const { encrypt, STORAGE_ROOT } = await import('../storage.ts');
const { writeJsonFile } = await import('../session/state.ts');

const BASE = {
  id: 'req1',
  action: { kind: 'access' as const },
  ownerKey: 'ab'.repeat(32),
  createdAt: '2026-10-12T10:00:00.000Z',
  expiresAt: '2026-10-12T10:10:00.000Z'
};
const ATTEMPT = {
  email: 'o@example.com',
  verifier: 'v',
  challenge: 'c',
  sessionLifetimeSeconds: 600
};

describe('pending request file', () => {
  it('loads a file written before sign-in methods as an email request', () => {
    const wallet = 'old-file';
    const old = { ...BASE, wallet, email: 'o@example.com', attempt: ATTEMPT };
    fs.mkdirSync(path.join(STORAGE_ROOT, 'pending'), { recursive: true });
    writeJsonFile({
      file: path.join(STORAGE_ROOT, 'pending', `${wallet}.json`),
      data: encrypt(JSON.stringify(old))
    });
    expect(loadPending(wallet)).toEqual({ ...old, method: 'email' });
  });

  it('round-trips a browser request', async () => {
    const wallet = 'browser-file';
    const request = { ...BASE, wallet, method: 'browser' as const, relaySession: 'sess-1' };
    await savePending(request);
    expect(loadPending(wallet)).toEqual(request);
  });

  it('round-trips an email request', async () => {
    const wallet = 'email-file';
    const request = {
      ...BASE,
      wallet,
      method: 'email' as const,
      email: 'o@example.com',
      attempt: ATTEMPT
    };
    await savePending(request);
    expect(loadPending(wallet)).toEqual(request);
  });

  it('rejects a browser request without its relay session', async () => {
    const wallet = 'browser-broken';
    fs.mkdirSync(path.join(STORAGE_ROOT, 'pending'), { recursive: true });
    writeJsonFile({
      file: path.join(STORAGE_ROOT, 'pending', `${wallet}.json`),
      data: encrypt(JSON.stringify({ ...BASE, wallet, method: 'browser' }))
    });
    expect(loadPending(wallet)).toBeNull();
  });
});

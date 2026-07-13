import { describe, expect, it } from 'vitest';

import type { SessionStore } from './login-session.ts';

import { LoginSessionCore, validLoginStatus } from './login-session.ts';

function memoryStore(): SessionStore {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async (entries) => {
      for (const [k, v] of Object.entries(entries)) map.set(k, v);
    },
    delete: async (key) => map.delete(key),
    deleteAll: async () => map.clear()
  };
}

describe('LoginSessionCore', () => {
  it('reports expired before register', async () => {
    const core = new LoginSessionCore(memoryStore());
    expect(await core.getStatus()).toEqual({ status: 'expired' });
    expect(await core.nextAction()).toEqual({ state: 'expired' });
    expect(await core.submitAction({ type: 'google' })).toEqual({ ok: false, error: 'expired' });
  });

  it('register arms the session with awaiting-method', async () => {
    const core = new LoginSessionCore(memoryStore());
    await core.register();
    expect(await core.getStatus()).toEqual({ status: 'awaiting-method' });
    expect(await core.nextAction()).toEqual({ state: 'pending' });
  });

  it('actions are one-time reads', async () => {
    const core = new LoginSessionCore(memoryStore());
    await core.register();
    await core.submitAction({ type: 'email', email: 'a@b.co' });
    expect(await core.nextAction()).toEqual({
      state: 'action',
      action: { type: 'email', email: 'a@b.co' }
    });
    expect(await core.nextAction()).toEqual({ state: 'pending' });
  });

  it('a newer action replaces an unconsumed one (latest wins)', async () => {
    const core = new LoginSessionCore(memoryStore());
    await core.register();
    await core.submitAction({ type: 'google' });
    await core.submitAction({ type: 'cancel' });
    expect(await core.nextAction()).toEqual({ state: 'action', action: { type: 'cancel' } });
  });

  it('status round-trips and is repeat-readable', async () => {
    const core = new LoginSessionCore(memoryStore());
    await core.register();
    await core.setStatus({ status: 'otp-sent' });
    expect(await core.getStatus()).toEqual({ status: 'otp-sent' });
    expect(await core.getStatus()).toEqual({ status: 'otp-sent' });
  });

  it('rejects actions after a terminal status', async () => {
    const core = new LoginSessionCore(memoryStore());
    await core.register();
    await core.setStatus({ status: 'done', walletAddress: '0xabc' });
    expect(await core.submitAction({ type: 'otp', code: '123456' })).toEqual({
      ok: false,
      error: 'finished'
    });
    expect(await core.getStatus()).toEqual({ status: 'done', walletAddress: '0xabc' });
  });

  it('deleteAll expires everything (alarm behavior)', async () => {
    const store = memoryStore();
    const core = new LoginSessionCore(store);
    await core.register();
    await store.deleteAll();
    expect(await core.getStatus()).toEqual({ status: 'expired' });
  });

  it('setStatus before register does not write and leaves getStatus expired', async () => {
    const core = new LoginSessionCore(memoryStore());
    expect(await core.setStatus({ status: 'otp-sent' })).toEqual({ ok: false });
    expect(await core.getStatus()).toEqual({ status: 'expired' });
  });

  it('setStatus after register writes and reports ok', async () => {
    const core = new LoginSessionCore(memoryStore());
    await core.register();
    expect(await core.setStatus({ status: 'otp-sent' })).toEqual({ ok: true });
    expect(await core.getStatus()).toEqual({ status: 'otp-sent' });
  });
});

describe('validLoginStatus', () => {
  it('accepts every valid status shape', () => {
    expect(validLoginStatus({ status: 'awaiting-method' })).toBe(true);
    expect(validLoginStatus({ status: 'auth-url', url: 'https://accounts.google.com' })).toBe(true);
    expect(validLoginStatus({ status: 'otp-sent' })).toBe(true);
    expect(validLoginStatus({ status: 'otp-invalid' })).toBe(true);
    expect(validLoginStatus({ status: 'otp-invalid', attemptsLeft: 2 })).toBe(true);
    expect(validLoginStatus({ status: 'done', walletAddress: '0xabc' })).toBe(true);
    expect(validLoginStatus({ status: 'error', message: 'boom' })).toBe(true);
  });

  it('rejects auth-url missing its url', () => {
    expect(validLoginStatus({ status: 'auth-url' })).toBe(false);
  });

  it('rejects a non-string message', () => {
    expect(validLoginStatus({ status: 'error', message: 123 })).toBe(false);
  });

  it('rejects an unknown status string', () => {
    expect(validLoginStatus({ status: 'bogus' })).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(validLoginStatus(null)).toBe(false);
    expect(validLoginStatus('done')).toBe(false);
    expect(validLoginStatus(42)).toBe(false);
    expect(validLoginStatus(undefined)).toBe(false);
  });
});

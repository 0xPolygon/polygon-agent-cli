import { describe, expect, it } from 'vitest';

import type { SessionStore } from './login-session.ts';

import { LoginSessionCore, parseLoginStatus } from './login-session.ts';

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

describe('parseLoginStatus', () => {
  it('parses and normalizes every valid status shape', () => {
    expect(parseLoginStatus({ status: 'awaiting-method' })).toEqual({
      status: 'awaiting-method'
    });
    expect(parseLoginStatus({ status: 'auth-url', url: 'https://accounts.google.com' })).toEqual({
      status: 'auth-url',
      url: 'https://accounts.google.com'
    });
    expect(parseLoginStatus({ status: 'otp-sent' })).toEqual({ status: 'otp-sent' });
    expect(parseLoginStatus({ status: 'otp-invalid' })).toEqual({
      status: 'otp-invalid'
    });
    expect(parseLoginStatus({ status: 'otp-invalid', attemptsLeft: 2 })).toEqual({
      status: 'otp-invalid',
      attemptsLeft: 2
    });
    expect(parseLoginStatus({ status: 'done', walletAddress: '0xabc' })).toEqual({
      status: 'done',
      walletAddress: '0xabc'
    });
    expect(parseLoginStatus({ status: 'error', message: 'boom' })).toEqual({
      status: 'error',
      message: 'boom'
    });
  });

  it('rejects auth-url missing its url', () => {
    expect(parseLoginStatus({ status: 'auth-url' })).toEqual(null);
  });

  it('rejects a non-string message', () => {
    expect(parseLoginStatus({ status: 'error', message: 123 })).toEqual(null);
  });

  it('rejects an unknown status string', () => {
    expect(parseLoginStatus({ status: 'bogus' })).toEqual(null);
  });

  it('rejects non-object input', () => {
    expect(parseLoginStatus(null)).toEqual(null);
    expect(parseLoginStatus('done')).toEqual(null);
    expect(parseLoginStatus(42)).toEqual(null);
    expect(parseLoginStatus(undefined)).toEqual(null);
  });

  it('strips extra properties not part of the status shape', () => {
    expect(parseLoginStatus({ status: 'otp-sent', junk: 'x' })).toEqual({
      status: 'otp-sent'
    });
    expect(parseLoginStatus({ status: 'auth-url', url: 'https://example.com', junk: 'x' })).toEqual(
      {
        status: 'auth-url',
        url: 'https://example.com'
      }
    );
    expect(parseLoginStatus({ status: 'done', walletAddress: '0xabc', junk: 'x' })).toEqual({
      status: 'done',
      walletAddress: '0xabc'
    });
  });
});

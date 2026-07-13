import { describe, expect, it } from 'vitest';

import type { MachineState } from './machine.ts';

import { initialState, reduce } from './machine.ts';

describe('login machine', () => {
  it('google: method -> google-wait -> success', () => {
    let s: MachineState = initialState;
    s = reduce(s, { type: 'choose-google' });
    expect(s).toEqual({ kind: 'google-wait' });
    s = reduce(s, { type: 'status', status: { status: 'done', walletAddress: '0xW' } });
    expect(s).toEqual({ kind: 'success', walletAddress: '0xW' });
  });

  it('email: full path with an otp retry', () => {
    let s: MachineState = initialState;
    s = reduce(s, { type: 'choose-email' });
    expect(s).toEqual({ kind: 'email-entry' });
    s = reduce(s, { type: 'submit-email', email: 'a@b.co' });
    expect(s).toEqual({ kind: 'email-wait', email: 'a@b.co' });
    s = reduce(s, { type: 'status', status: { status: 'otp-sent' } });
    expect(s).toEqual({ kind: 'otp-entry', email: 'a@b.co' });
    s = reduce(s, { type: 'submit-otp', code: '111111' });
    expect(s).toEqual({ kind: 'otp-wait', email: 'a@b.co' });
    s = reduce(s, { type: 'status', status: { status: 'otp-invalid', attemptsLeft: 2 } });
    expect(s).toEqual({ kind: 'otp-entry', email: 'a@b.co', attemptsLeft: 2, invalid: true });
    s = reduce(s, { type: 'submit-otp', code: '222222' });
    s = reduce(s, { type: 'status', status: { status: 'done', walletAddress: '0xW' } });
    expect(s).toEqual({ kind: 'success', walletAddress: '0xW' });
  });

  it('expired and error statuses are terminal from any state', () => {
    expect(reduce(initialState, { type: 'status', status: { status: 'expired' } })).toEqual({
      kind: 'expired'
    });
    expect(
      reduce(
        { kind: 'otp-wait', email: 'a@b.co' },
        { type: 'status', status: { status: 'error', message: 'boom' } }
      )
    ).toEqual({ kind: 'failed', message: 'boom' });
  });

  it('reconciles a refreshed page from the polled status', () => {
    // After a refresh the page is back at `method`; the poll snaps it forward.
    expect(reduce(initialState, { type: 'status', status: { status: 'otp-sent' } })).toEqual({
      kind: 'otp-entry',
      email: ''
    });
    expect(
      reduce(initialState, { type: 'status', status: { status: 'done', walletAddress: '0xW' } })
    ).toEqual({ kind: 'success', walletAddress: '0xW' });
  });

  it('back returns from email entry to method choice', () => {
    expect(reduce({ kind: 'email-entry' }, { type: 'back' })).toEqual({ kind: 'method' });
  });

  it('awaiting-method and stale statuses do not regress the ui', () => {
    expect(
      reduce({ kind: 'email-entry' }, { type: 'status', status: { status: 'awaiting-method' } })
    ).toEqual({ kind: 'email-entry' });
    // auth-url is handled as a side effect (redirect); state is unchanged.
    expect(
      reduce(
        { kind: 'google-wait' },
        { type: 'status', status: { status: 'auth-url', url: 'https://x' } }
      )
    ).toEqual({ kind: 'google-wait' });
  });

  it('terminal states absorb any later status or event', () => {
    const success: MachineState = { kind: 'success', walletAddress: '0xW' };
    expect(reduce(success, { type: 'status', status: { status: 'otp-sent' } })).toEqual(success);
    expect(
      reduce(
        { kind: 'failed', message: 'boom' },
        { type: 'status', status: { status: 'done', walletAddress: '0xW' } }
      )
    ).toEqual({ kind: 'failed', message: 'boom' });
    expect(reduce({ kind: 'expired' }, { type: 'choose-google' })).toEqual({ kind: 'expired' });
  });

  it('user events from illegal states are no-ops', () => {
    expect(reduce({ kind: 'email-entry' }, { type: 'submit-otp', code: '123456' })).toEqual({
      kind: 'email-entry'
    });
    expect(reduce({ kind: 'otp-entry', email: 'a@b.co' }, { type: 'choose-google' })).toEqual({
      kind: 'otp-entry',
      email: 'a@b.co'
    });
    expect(reduce(initialState, { type: 'submit-email', email: 'a@b.co' })).toEqual({
      kind: 'method'
    });
    expect(
      reduce(
        { kind: 'email-wait', email: 'a@b.co' },
        { type: 'status', status: { status: 'otp-invalid' } }
      )
    ).toEqual({ kind: 'email-wait', email: 'a@b.co' });
  });
});

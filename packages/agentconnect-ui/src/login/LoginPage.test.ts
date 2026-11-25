import { describe, expect, it } from 'vitest';

import { parseRelayStatus } from './LoginPage';

describe('parseRelayStatus', () => {
  it('keeps a known context', () => {
    expect(
      parseRelayStatus({ status: 'done', walletAddress: '0xabc', context: { purpose: 'connect' } })
    ).toMatchObject({ status: 'done', walletAddress: '0xabc', context: { purpose: 'connect' } });
  });

  it('still reaches done and error when the context is unknown or null', () => {
    for (const context of [{ purpose: 'brand-new' }, null, 'junk']) {
      expect(parseRelayStatus({ status: 'done', walletAddress: '0xabc', context })).toMatchObject({
        status: 'done',
        walletAddress: '0xabc'
      });
      expect(parseRelayStatus({ status: 'error', message: 'nope', context })).toMatchObject({
        status: 'error',
        message: 'nope'
      });
    }
  });

  it('tolerates added fields and skips a status it does not know', () => {
    expect(parseRelayStatus({ status: 'otp-sent', extra: 1 })).toMatchObject({
      status: 'otp-sent'
    });
    expect(parseRelayStatus({ status: 'from-the-future' })).toBeNull();
    expect(parseRelayStatus(null)).toBeNull();
  });
});

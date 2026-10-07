// The keys that make a session alert new for `watch check`: expiry alerts at
// 7 days and 1 day, uncovered funds when a different token turns up.

import { describe, expect, it } from 'vitest';

import type { LiveSession } from './sessions.ts';

import { sessionAlerts } from './status.ts';

const NOW = new Date('2026-10-07T12:00:00Z');
const DAY = 86_400_000;

const session = (expiresInMs: number): LiveSession => ({
  chainId: 137,
  sessionId: 's',
  walletId: 'w',
  expiresAt: new Date(NOW.getTime() + expiresInMs).toISOString(),
  expired: expiresInMs <= 0,
  grants: []
});

const keys = (params: Partial<Parameters<typeof sessionAlerts>[0]>) =>
  sessionAlerts({ sessions: [], approved: null, spent: 0, holdings: [], now: NOW, ...params }).map(
    (alert) => alert.key
  );

const uncovered = (symbol: string, token: string, balance: string) => ({
  chain: 'Polygon',
  chainId: 137,
  symbol,
  token,
  balance,
  status: 'not_covered' as const
});

describe('session alert keys', () => {
  it('expiry: one key for the week before, another for the last day, another once expired', () => {
    expect(keys({ sessions: [session(6 * DAY)] })).toEqual(['expiring:7d']);
    expect(keys({ sessions: [session(2 * DAY)] })).toEqual(['expiring:7d']);
    expect(keys({ sessions: [session(DAY / 2)] })).toEqual(['expiring:1d']);
    expect(keys({ sessions: [session(-1)] })).toEqual(['expired']);
    expect(keys({ sessions: [session(30 * DAY)] })).toEqual([]);
  });

  it('uncovered funds: the same tokens keep the key whatever the amounts; a new one changes it', () => {
    const a = keys({ holdings: [uncovered('LINK', '0xAA', '1')] });
    expect(keys({ holdings: [uncovered('LINK', '0xaa', '5')] })).toEqual(a);
    expect(
      keys({ holdings: [uncovered('LINK', '0xAA', '1'), uncovered('UNI', '0xBB', '1')] })
    ).not.toEqual(a);
  });
});

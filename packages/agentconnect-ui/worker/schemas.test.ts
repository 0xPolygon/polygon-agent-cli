import { describe, expect, it } from 'vitest';

import { AgentKeyRequest } from './schemas.ts';

describe('AgentKeyRequest', () => {
  it('reads a missing half of the owner region as unknown', () => {
    const parsed = AgentKeyRequest.parse({
      op: 'pm_account',
      wallet: '0xabc',
      ownerRegion: { country: 'US' }
    });
    expect(parsed).toMatchObject({ ownerRegion: { country: 'US', region: null } });
    expect(AgentKeyRequest.parse({ op: 'owner_seen', wallet: '0xabc', region: {} })).toMatchObject({
      region: { country: null, region: null }
    });
  });

  // The token kinds a plan can hold are checked at compile time against TokenKind (see schemas.ts).
  it('parses a plan grant of every kind', () => {
    for (const kind of ['usd', 'eth', 'btc', 'pol']) {
      const grant = { symbol: 'X', token: '0x1', decimals: 6, kind, limit: '1', priceUsd: 1 };
      const res = AgentKeyRequest.safeParse({
        op: 'approve',
        wallet: '0xabc',
        plan: {
          allowanceUsd: 10,
          days: 1,
          expiresAt: 'x',
          chains: [{ chainId: 137, grants: [grant] }]
        },
        approved: []
      });
      expect(res.success).toBe(true);
    }
  });
});

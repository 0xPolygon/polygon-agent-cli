import { describe, expect, it, vi } from 'vitest';

const market = (over: Record<string, unknown> = {}) => ({
  id: '1',
  slug: 'will-x',
  conditionId: `0x${'a'.repeat(64)}`,
  question: 'Will X?',
  version: 'v1',
  groupItemTitle: null,
  state: { acceptingOrders: true, closed: false, negRisk: false },
  outcomes: {
    yes: { label: 'Yes', tokenId: 'T-YES', positionId: 'P-YES', price: '0.4' },
    no: { label: 'No', tokenId: 'T-NO', positionId: 'P-NO', price: '0.6' }
  },
  prices: {},
  metrics: {},
  ...over
});

const pub = vi.hoisted(() => ({
  listMarkets: vi.fn(),
  fetchMarket: vi.fn(),
  fetchEvent: vi.fn(),
  Rejected: class extends Error {
    status = 404;
  }
}));

vi.mock('./sdk.ts', async (o) => ({
  ...(await o<Record<string, unknown>>()),
  loadSdk: async () => ({
    root: {
      createPublicClient: () => pub,
      RequestRejectedError: pub.Rejected
    }
  })
}));

const { resolveOutcome } = await import('./resolve.ts');
const { loadSdk } = await import('./sdk.ts');

describe('resolveOutcome', () => {
  it('resolves a conditionId and a yes/no outcome to the v1 token id', async () => {
    pub.listMarkets.mockReturnValue({ firstPage: async () => ({ items: [market()] }) });
    const r = await resolveOutcome(`0x${'a'.repeat(64)}`, 'yes');
    expect(r).toMatchObject({ outcome: 'yes', assetId: 'T-YES', price: '0.4' });
  });

  it('uses positionId for v2 markets', async () => {
    pub.fetchMarket.mockResolvedValue(market({ version: 'v2' }));
    expect((await resolveOutcome('will-x', 'No')).assetId).toBe('P-NO');
  });

  it("resolves an event slug and a candidate name to that market's YES side", async () => {
    const { root } = await loadSdk();
    pub.fetchMarket.mockRejectedValue(
      new (root.RequestRejectedError as never as new () => Error)()
    );
    pub.fetchEvent.mockResolvedValue({
      slug: 'election',
      markets: [
        market({
          id: '1',
          groupItemTitle: 'Alice',
          outcomes: {
            yes: { label: 'Yes', tokenId: 'A-Y', price: '0.3' },
            no: { label: 'No', tokenId: 'A-N', price: '0.7' }
          }
        }),
        market({
          id: '2',
          groupItemTitle: 'Bob',
          outcomes: {
            yes: { label: 'Yes', tokenId: 'B-Y', price: '0.6' },
            no: { label: 'No', tokenId: 'B-N', price: '0.4' }
          }
        })
      ]
    });
    expect((await resolveOutcome('election', 'bob')).assetId).toBe('B-Y');
    expect((await resolveOutcome('election', 'bob no')).assetId).toBe('B-N');
  });

  it('lists the choices when the outcome is unknown', async () => {
    pub.fetchMarket.mockResolvedValue(market());
    await expect(resolveOutcome('will-x', 'maybe')).rejects.toMatchObject({
      code: 'outcome_not_found',
      details: { choices: ['Yes', 'No'] }
    });
  });

  it('refuses an ambiguous partial match', async () => {
    const { root } = await loadSdk();
    pub.fetchMarket.mockRejectedValue(
      new (root.RequestRejectedError as never as new () => Error)()
    );
    pub.fetchEvent.mockResolvedValue({
      slug: 'e',
      markets: [
        market({ groupItemTitle: 'John Smith' }),
        market({ id: '2', groupItemTitle: 'John Doe' })
      ]
    });
    await expect(resolveOutcome('e', 'john')).rejects.toMatchObject({ code: 'ambiguous_market' });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
  estimateMarketPrice: vi.fn(),
  placeMarketOrder: vi.fn(),
  placeLimitOrder: vi.fn(),
  listPositions: vi.fn(),
  fetchClosedOnlyMode: vi.fn(async () => false)
}));
const region = vi.hoisted(() => ({
  value: { blocked: false, closeOnly: false, country: 'PT', region: null as string | null }
}));
const pusd = vi.hoisted(() => ({ value: 50_000_000n }));
const mk = vi.hoisted(() => ({
  market: { slug: 'will-x', conditionId: '0xc' } as Record<string, unknown>
}));
const updateBalanceAllowance = vi.hoisted(() => vi.fn());

vi.mock('./account.ts', () => ({
  getTradingClient: async () => client,
  pusdBalance: async () => pusd.value
}));
vi.mock('./region.ts', async (o) => ({
  ...(await o<Record<string, unknown>>()),
  checkRegion: async () => region.value
}));
vi.mock('./resolve.ts', () => ({
  resolveOutcome: async () => ({
    market: mk.market,
    outcome: 'yes',
    label: 'Yes',
    assetId: 'T-YES',
    price: '0.4'
  })
}));
vi.mock('./sdk.ts', async (o) => ({
  ...(await o<Record<string, unknown>>()),
  loadSdk: async () => ({
    root: {
      OrderSide: { BUY: 'BUY', SELL: 'SELL' },
      OrderType: { FAK: 'FAK' },
      AssetType: { CONDITIONAL: 'CONDITIONAL', CONDITIONAL_V2: 'CONDITIONAL-V2' }
    },
    actions: { updateBalanceAllowance }
  })
}));

const { buy, sell } = await import('./orders.ts');

const filled = {
  ok: true,
  orderId: 'o1',
  status: 'matched',
  makingAmount: '5',
  takingAmount: '10',
  transactionsHashes: [],
  tradeIds: []
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.POLYMARKET_BUILDER_CODE;
  pusd.value = 50_000_000n;
  mk.market = { slug: 'will-x', conditionId: '0xc' };
  region.value = { blocked: false, closeOnly: false, country: 'PT', region: null };
});

describe('buy', () => {
  it('refuses when the estimated fill is worse than --max-price and posts nothing', async () => {
    client.estimateMarketPrice.mockResolvedValue(0.62);
    await expect(
      buy({
        wallet: 'main',
        ref: 'will-x',
        outcome: 'yes',
        usd: '5',
        maxPrice: 0.55,
        broadcast: true
      })
    ).rejects.toMatchObject({
      code: 'price_guard',
      details: { estimatedPrice: 0.62, maxPrice: 0.55 }
    });
    expect(client.placeMarketOrder).not.toHaveBeenCalled();
  });

  it('passes maxPrice to the venue when the estimate is within it', async () => {
    client.estimateMarketPrice.mockResolvedValue(0.5);
    client.placeMarketOrder.mockResolvedValue(filled);
    const out = await buy({
      wallet: 'main',
      ref: 'will-x',
      outcome: 'yes',
      usd: '5',
      maxPrice: 0.55,
      broadcast: true
    });
    expect(client.placeMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: 'T-YES',
        side: 'BUY',
        amount: '5',
        maxSpend: '5',
        maxPrice: 0.55,
        orderType: 'FAK'
      })
    );
    expect(out).toMatchObject({
      orderId: 'o1',
      status: 'matched',
      filledUsd: '5',
      filledShares: '10'
    });
  });

  it('dry run posts nothing and reports the estimate', async () => {
    client.estimateMarketPrice.mockResolvedValue(0.5);
    const out = await buy({
      wallet: 'main',
      ref: 'will-x',
      outcome: 'yes',
      usd: '5',
      broadcast: false
    });
    expect(out).toMatchObject({
      dryRun: true,
      estimatedPrice: 0.5,
      estimatedShares: 10,
      orderType: 'market'
    });
    expect(client.placeMarketOrder).not.toHaveBeenCalled();
  });

  it('is refused in a close-only region', async () => {
    region.value = { ...region.value, closeOnly: true };
    await expect(
      buy({ wallet: 'main', ref: 'will-x', outcome: 'yes', usd: '5', broadcast: false })
    ).rejects.toMatchObject({ code: 'region_close_only' });
  });

  it('refuses with insufficient_pusd and a deposit hint, posting nothing', async () => {
    pusd.value = 1_000_000n;
    client.estimateMarketPrice.mockResolvedValue(0.5);
    await expect(
      buy({ wallet: 'main', ref: 'will-x', outcome: 'yes', usd: '5', broadcast: true })
    ).rejects.toMatchObject({
      code: 'insufficient_pusd',
      hint: expect.stringContaining('agent polymarket deposit 5')
    });
    expect(client.placeMarketOrder).not.toHaveBeenCalled();
  });

  it('turns a venue rejection into order_rejected', async () => {
    client.estimateMarketPrice.mockResolvedValue(0.5);
    client.placeMarketOrder.mockResolvedValue({
      ok: false,
      code: 'fak_not_filled',
      message: 'no liquidity'
    });
    await expect(
      buy({ wallet: 'main', ref: 'will-x', outcome: 'yes', usd: '5', broadcast: true })
    ).rejects.toMatchObject({ code: 'order_rejected', details: { venueCode: 'fak_not_filled' } });
  });

  it('places a limit buy sized in shares', async () => {
    client.placeLimitOrder.mockResolvedValue({ ...filled, orderId: 'o2', status: 'live' });
    await buy({
      wallet: 'main',
      ref: 'will-x',
      outcome: 'yes',
      usd: '5',
      limitPrice: 0.3,
      broadcast: true
    });
    expect(client.placeLimitOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'BUY', price: 0.3, size: 16.66 })
    );
  });

  it('rejects an --expires under 3 minutes before posting', async () => {
    await expect(
      buy({
        wallet: 'main',
        ref: 'will-x',
        outcome: 'yes',
        usd: '5',
        limitPrice: 0.3,
        expiresMinutes: 2,
        broadcast: true
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(client.placeLimitOrder).not.toHaveBeenCalled();
  });

  it('caps the all-in spend (fees included) at the requested amount', async () => {
    client.estimateMarketPrice.mockResolvedValue(0.5);
    client.placeMarketOrder.mockResolvedValue(filled);
    await buy({ wallet: 'main', ref: 'will-x', outcome: 'yes', usd: '5.25', broadcast: true });
    expect(client.placeMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({ amount: '5.25', maxSpend: '5.25' })
    );
  });

  it.each([
    ['closed', { closed: true, acceptingOrders: false }],
    ['paused', { closed: false, acceptingOrders: false }]
  ])('refuses a %s market before reading balances or estimating', async (_n, state) => {
    mk.market = { slug: 'will-x', conditionId: '0xc', state };
    pusd.value = 0n; // a balance read first would fail with insufficient_pusd instead
    await expect(
      buy({ wallet: 'main', ref: 'will-x', outcome: 'yes', usd: '5', broadcast: true })
    ).rejects.toMatchObject({ code: 'market_not_accepting_orders' });
    expect(client.estimateMarketPrice).not.toHaveBeenCalled();
    expect(client.placeMarketOrder).not.toHaveBeenCalled();
  });

  it('allows a v2 market that is accepting orders', async () => {
    mk.market = {
      slug: 'will-x',
      conditionId: '0xc',
      version: 'v2',
      state: { closed: false, acceptingOrders: true }
    };
    client.estimateMarketPrice.mockResolvedValue(0.5);
    await expect(
      buy({ wallet: 'main', ref: 'will-x', outcome: 'yes', usd: '5', broadcast: false })
    ).resolves.toMatchObject({ dryRun: true });
  });

  it('rejects --expires on a market order before any call', async () => {
    await expect(
      buy({
        wallet: 'main',
        ref: 'will-x',
        outcome: 'yes',
        usd: '5',
        maxPrice: 0.5,
        expiresMinutes: 10,
        broadcast: true
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(client.estimateMarketPrice).not.toHaveBeenCalled();
    expect(client.placeMarketOrder).not.toHaveBeenCalled();
  });

  it('adds the builder code only when configured', async () => {
    client.estimateMarketPrice.mockResolvedValue(0.5);
    client.placeMarketOrder.mockResolvedValue(filled);
    process.env.POLYMARKET_BUILDER_CODE = '0xabc';
    await buy({ wallet: 'main', ref: 'will-x', outcome: 'yes', usd: '5', broadcast: true });
    expect(client.placeMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({ builderCode: '0xabc' })
    );
  });
});

describe('price flag conflicts', () => {
  const nothingCalled = () => {
    expect(client.placeMarketOrder).not.toHaveBeenCalled();
    expect(client.placeLimitOrder).not.toHaveBeenCalled();
    expect(client.estimateMarketPrice).not.toHaveBeenCalled();
  };

  it('buy rejects --price with --max-price before any call', async () => {
    await expect(
      buy({
        wallet: 'main',
        ref: 'will-x',
        outcome: 'yes',
        usd: '5',
        maxPrice: 0.5,
        limitPrice: 0.9,
        broadcast: true
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    nothingCalled();
  });

  it('sell rejects --price with --min-price before any call', async () => {
    await expect(
      sell({
        wallet: 'main',
        ref: 'will-x',
        outcome: 'yes',
        shares: '3',
        minPrice: 0.5,
        limitPrice: 0.3,
        broadcast: true
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    nothingCalled();
  });
});

describe('sell', () => {
  // The conditional token balance, in 6-decimal base units.
  const held = (size: string) =>
    updateBalanceAllowance.mockResolvedValue({
      balance: String(Math.round(Number(size) * 1e6)),
      allowances: {}
    });

  it('sizes the position from the refreshed conditional balance, not the Data API', async () => {
    held('12.5');
    client.estimateMarketPrice.mockResolvedValue(0.4);
    await sell({ wallet: 'main', ref: 'will-x', outcome: 'yes', shares: 'all', broadcast: false });
    expect(updateBalanceAllowance).toHaveBeenCalledWith(client, {
      assetType: 'CONDITIONAL',
      assetId: 'T-YES'
    });
    expect(client.listPositions).not.toHaveBeenCalled();
  });

  it('uses the CONDITIONAL-V2 asset type for a v2 market', async () => {
    mk.market = { slug: 'will-x', conditionId: '0xc', version: 'v2' };
    held('3');
    client.estimateMarketPrice.mockResolvedValue(0.4);
    await sell({ wallet: 'main', ref: 'will-x', outcome: 'yes', shares: '3', broadcast: false });
    expect(updateBalanceAllowance).toHaveBeenCalledWith(client, {
      assetType: 'CONDITIONAL-V2',
      assetId: 'T-YES'
    });
  });

  it('sells all held shares', async () => {
    held('12.5');
    client.estimateMarketPrice.mockResolvedValue(0.39);
    client.placeMarketOrder.mockResolvedValue({
      ...filled,
      orderId: 'o3',
      makingAmount: '12.5',
      takingAmount: '4.87'
    });
    const out = await sell({
      wallet: 'main',
      ref: 'will-x',
      outcome: 'yes',
      shares: 'all',
      broadcast: true
    });
    expect(client.placeMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'SELL', shares: 12.5 })
    );
    expect(out).toMatchObject({ filledUsd: '4.87', filledShares: '12.5' });
  });

  it('refuses all with no position, posting nothing', async () => {
    updateBalanceAllowance.mockResolvedValue({ balance: '0', allowances: {} });
    await expect(
      sell({ wallet: 'main', ref: 'will-x', outcome: 'yes', shares: 'all', broadcast: true })
    ).rejects.toMatchObject({ code: 'insufficient_shares' });
    expect(client.placeMarketOrder).not.toHaveBeenCalled();
    expect(client.placeLimitOrder).not.toHaveBeenCalled();
  });

  it('refuses all when the position is 0', async () => {
    held('0');
    await expect(
      sell({ wallet: 'main', ref: 'will-x', outcome: 'yes', shares: 'all', broadcast: true })
    ).rejects.toMatchObject({ code: 'insufficient_shares' });
    expect(client.placeMarketOrder).not.toHaveBeenCalled();
  });

  it('refuses more than held', async () => {
    held('3');
    await expect(
      sell({ wallet: 'main', ref: 'will-x', outcome: 'yes', shares: '4', broadcast: true })
    ).rejects.toMatchObject({ code: 'insufficient_shares' });
    expect(client.placeMarketOrder).not.toHaveBeenCalled();
  });

  it('still works in a close-only region', async () => {
    region.value = { ...region.value, closeOnly: true };
    held('3');
    client.estimateMarketPrice.mockResolvedValue(0.4);
    await expect(
      sell({ wallet: 'main', ref: 'will-x', outcome: 'yes', shares: '3', broadcast: false })
    ).resolves.toMatchObject({ dryRun: true });
  });

  it('refuses a min-price breach and posts nothing', async () => {
    held('3');
    client.estimateMarketPrice.mockResolvedValue(0.2);
    await expect(
      sell({
        wallet: 'main',
        ref: 'will-x',
        outcome: 'yes',
        shares: '3',
        minPrice: 0.3,
        broadcast: true
      })
    ).rejects.toMatchObject({ code: 'price_guard' });
    expect(client.placeMarketOrder).not.toHaveBeenCalled();
  });

  it('passes minPrice to the venue when within it', async () => {
    held('3');
    client.estimateMarketPrice.mockResolvedValue(0.4);
    client.placeMarketOrder.mockResolvedValue(filled);
    await sell({
      wallet: 'main',
      ref: 'will-x',
      outcome: 'yes',
      shares: '3',
      minPrice: 0.3,
      broadcast: true
    });
    expect(client.placeMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'SELL', shares: 3, minPrice: 0.3, orderType: 'FAK' })
    );
  });

  it('rejects --expires on a market sell before any call', async () => {
    held('3');
    await expect(
      sell({
        wallet: 'main',
        ref: 'will-x',
        outcome: 'yes',
        shares: '3',
        expiresMinutes: 10,
        broadcast: true
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(client.estimateMarketPrice).not.toHaveBeenCalled();
    expect(client.placeMarketOrder).not.toHaveBeenCalled();
  });

  it('places a limit sell with an expiration', async () => {
    held('3');
    client.placeLimitOrder.mockResolvedValue(filled);
    await sell({
      wallet: 'main',
      ref: 'will-x',
      outcome: 'yes',
      shares: '3',
      limitPrice: 0.7,
      expiresMinutes: 10,
      broadcast: true
    });
    const arg = client.placeLimitOrder.mock.calls[0][0];
    expect(arg).toMatchObject({ side: 'SELL', price: 0.7, size: 3 });
    expect(arg.expiration).toBeGreaterThan(Math.floor(Date.now() / 1000) + 9 * 60);
  });
});

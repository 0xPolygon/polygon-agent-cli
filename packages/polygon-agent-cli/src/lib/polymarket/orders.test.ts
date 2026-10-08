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
    market: { slug: 'will-x', conditionId: '0xc' },
    outcome: 'yes',
    label: 'Yes',
    assetId: 'T-YES',
    price: '0.4'
  })
}));
vi.mock('./sdk.ts', async (o) => ({
  ...(await o<Record<string, unknown>>()),
  loadSdk: async () => ({
    root: { OrderSide: { BUY: 'BUY', SELL: 'SELL' }, OrderType: { FAK: 'FAK' } }
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

describe('sell', () => {
  const held = (size: string) =>
    client.listPositions.mockReturnValue({
      firstPage: async () => ({ items: [{ assetId: 'T-YES', currentSize: size }] })
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
    client.listPositions.mockReturnValue({ firstPage: async () => ({ items: [] }) });
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

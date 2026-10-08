import { afterEach, describe, expect, it, vi } from 'vitest';

import { bridgeStatus, depositAddress, withdrawAddress } from './bridge.ts';

const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.POLYMARKET_BUILDER_CODE;
});

describe('depositAddress', () => {
  it('posts the wallet and returns the evm address', async () => {
    const fn = mockFetch({ address: { evm: '0xB1', svm: 'S', btc: 'b' } });
    expect(await depositAddress('0xW')).toBe('0xB1');
    const [url, init] = fn.mock.calls[0];
    expect(String(url)).toBe('https://bridge.polymarket.com/deposit');
    expect(JSON.parse(init.body)).toEqual({ address: '0xW' });
    expect(init.headers['X-Builder-Code']).toBeUndefined();
  });

  it('sends the builder code header when configured', async () => {
    process.env.POLYMARKET_BUILDER_CODE = `0x${'ab'.repeat(32)}`;
    const fn = mockFetch({ address: { evm: '0xB1' } });
    await depositAddress('0xW');
    expect(fn.mock.calls[0][1].headers['X-Builder-Code']).toBe(`0x${'ab'.repeat(32)}`);
  });

  it('fails clearly when the bridge returns no evm address', async () => {
    mockFetch({ address: {} });
    await expect(depositAddress('0xW')).rejects.toMatchObject({ code: 'upstream_error' });
  });
});

describe('withdrawAddress', () => {
  it('defaults to Polygon USDC paid to the recipient', async () => {
    const fn = mockFetch({ address: { evm: '0xB2' } });
    expect(await withdrawAddress({ wallet: '0xW', recipient: '0xOMS' })).toBe('0xB2');
    expect(JSON.parse(fn.mock.calls[0][1].body)).toEqual({
      address: '0xW',
      toChainId: '137',
      toTokenAddress: USDC,
      recipientAddr: '0xOMS'
    });
  });
});

describe('bridgeStatus', () => {
  it('reads the status list', async () => {
    mockFetch({ transactions: [{ status: 'COMPLETED' }] });
    expect((await bridgeStatus('0xB1')).transactions[0].status).toBe('COMPLETED');
  });

  it('maps 5xx to upstream_unavailable', async () => {
    mockFetch({ error: 'down' }, 503);
    await expect(bridgeStatus('0xB1')).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });
});

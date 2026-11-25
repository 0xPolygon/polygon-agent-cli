import { encodePaymentRequiredHeader } from '@x402/core/http';
import { describe, expect, it } from 'vitest';

import type { Requirement, X402Deps } from './x402.ts';

import { MoneyError } from './errors.ts';
import { fakeEngine } from './test-fakes.ts';
import { checkUrl, payAndFetch, priceUsd, selectRequirement } from './x402.ts';

const USDC_POLYGON = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

const req = (overrides: Partial<Requirement> = {}): Requirement => ({
  scheme: 'exact',
  network: 'eip155:137',
  amount: '10000',
  asset: USDC_POLYGON,
  payTo: '0x00000000000000000000000000000000000000aa',
  maxTimeoutSeconds: 60,
  extra: { name: 'USD Coin' },
  ...overrides
});

describe('choosing what to pay', () => {
  it('takes the cheapest plain stablecoin transfer, on Polygon first', () => {
    const picked = selectRequirement([
      req({ network: 'eip155:8453', asset: USDC_BASE, amount: '1000' }),
      req({ amount: '20000' }),
      req({ amount: '10000' })
    ]);
    expect(picked).toMatchObject({ network: 'eip155:137', amount: '10000' });
  });

  it("skips what it can't sign or value", () => {
    expect(
      selectRequirement([
        req({ scheme: 'upto' }),
        req({ extra: { name: 'GatewayWallet' } }),
        req({ extra: { assetTransferMethod: 'permit2' } }),
        req({ asset: '0x00000000000000000000000000000000000000bb' }),
        req({ network: 'solana:mainnet' })
      ])
    ).toBeUndefined();
  });

  it('values stablecoins in dollars', () => {
    expect(priceUsd(req({ amount: '1500000' }))).toBe(1.5);
  });
});

describe('checkUrl', () => {
  it('only pays public https services, never this site', () => {
    expect(checkUrl('https://api.example.com/x', []).hostname).toBe('api.example.com');
    for (const bad of [
      'http://api.example.com',
      'https://localhost/x',
      'https://10.0.0.1/',
      'nope'
    ]) {
      expect(() => checkUrl(bad, [])).toThrow(MoneyError);
    }
    expect(() =>
      checkUrl('https://agents.polygon.technology/mcp', ['agents.polygon.technology'])
    ).toThrow(MoneyError);
  });
});

describe('payAndFetch', () => {
  const deps = (responses: Response[]): X402Deps => {
    const fake = fakeEngine();
    return {
      ...fake.deps,
      signerKey: async () => `0x${'11'.repeat(32)}`,
      x402: { pending: async () => [], putPending: async () => undefined },
      signerBalance: async () => 0n,
      fetch: (async () =>
        responses.shift() ?? new Response('gone', { status: 500 })) as typeof fetch
    };
  };
  const paymentRequired = (amount: string) =>
    new Response('{}', {
      status: 402,
      headers: {
        'PAYMENT-REQUIRED': encodePaymentRequiredHeader({
          x402Version: 2,
          resource: { url: 'https://api.example.com/search' },
          accepts: [req({ amount })]
        } as never)
      }
    });

  it('pays nothing when the service asks for nothing', async () => {
    const out = await payAndFetch(
      { url: 'https://api.example.com/free', maxUsd: 1 },
      deps([new Response('hello', { status: 200 })]),
      []
    );
    expect(out).toMatchObject({ status: 200, paidUsd: 0, body: 'hello' });
  });

  it('refuses a price over max_usd before funding anything', async () => {
    const d = deps([paymentRequired('2000000')]);
    await expect(
      payAndFetch({ url: 'https://api.example.com/search', maxUsd: 1 }, d, [])
    ).rejects.toMatchObject({ code: 'invalid_input', details: { priceUsd: 2 } });
  });

  it('validating offers does not change which one is chosen', async () => {
    const response = new Response('{}', {
      status: 402,
      headers: {
        'PAYMENT-REQUIRED': encodePaymentRequiredHeader({
          x402Version: 2,
          resource: { url: 'https://api.example.com/search' },
          accepts: [
            { ...req({ amount: '5000' }), maxTimeoutSeconds: '3600', extra: null },
            req({ network: 'eip155:8453', asset: USDC_BASE, amount: '1000' })
          ]
        } as never)
      }
    });
    // The Polygon offer is first and preferred, and it asks for more than the
    // allowed validity: the call is refused for that, not moved to the Base offer.
    await expect(
      payAndFetch({ url: 'https://api.example.com/search', maxUsd: 1 }, deps([response]), [])
    ).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('valid for 3600 s')
    });
  });

  // The wire format is JSON, so these are the shapes a service could send; each
  // must end as it would reading the raw reply: no offer this wallet can make.
  const offering = (accepts: unknown[]) =>
    new Response('{}', {
      status: 402,
      headers: {
        'PAYMENT-REQUIRED': encodePaymentRequiredHeader({
          x402Version: 2,
          resource: { url: 'https://api.example.com/search' },
          accepts
        } as never)
      }
    });
  const refusedAsNoOffer = (accepts: unknown[]) =>
    expect(
      payAndFetch(
        { url: 'https://api.example.com/search', maxUsd: 1 },
        deps([offering(accepts)]),
        []
      )
    ).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('offers no payment')
    });

  it('still refuses a gateway-named offer whose method is not a string', async () => {
    await refusedAsNoOffer([
      { ...req(), extra: { name: 'GatewayWalletBatched', assetTransferMethod: 5 } }
    ]);
  });

  it('still refuses an assetTransferMethod that is not eip3009', async () => {
    await refusedAsNoOffer([{ ...req(), extra: { assetTransferMethod: ['permit2'] } }]);
    await refusedAsNoOffer([{ ...req(), extra: { assetTransferMethod: null } }]);
  });

  it('refuses a timeout that coerces to Infinity, before funding anything', async () => {
    for (const maxTimeoutSeconds of ['Infinity', '1e999']) {
      await expect(
        payAndFetch(
          { url: 'https://api.example.com/search', maxUsd: 1 },
          deps([offering([{ ...req(), maxTimeoutSeconds }])]),
          []
        )
      ).rejects.toMatchObject({
        code: 'invalid_input',
        message: expect.stringContaining('valid for Infinity s')
      });
    }
  });

  it('needs a max_usd', async () => {
    await expect(
      payAndFetch({ url: 'https://api.example.com/search', maxUsd: NaN }, deps([]), [])
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it("won't follow a redirect", async () => {
    await expect(
      payAndFetch(
        { url: 'https://api.example.com/x', maxUsd: 1 },
        deps([
          new Response(null, { status: 302, headers: { Location: 'https://elsewhere.test' } })
        ]),
        []
      )
    ).rejects.toMatchObject({ code: 'upstream_error' });
  });
});

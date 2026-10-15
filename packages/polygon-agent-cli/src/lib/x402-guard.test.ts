import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-x402-'));

const {
  checkX402Price,
  parseBazaarPayment,
  markAuthorizationPending,
  pendingAuthorizations,
  releaseX402Reservation,
  reserveX402Payment,
  settleAuthorizationPending,
  signedAuthorization,
  withX402Lock,
  recordX402Payment,
  x402PriceUsd,
  x402SpentLastDay
} = await import('./x402-guard.ts');
const { CliError } = await import('./errors.ts');
const { decodeFunctionData, erc20Abi } = await import('viem');
const { updateConfig } = await import('./config.ts');

const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const NOW = new Date('2026-10-07T12:00:00Z');
const url = 'https://service.example/data';

beforeEach(() => {
  fs.rmSync(path.join(String(process.env.POLYGON_AGENT_HOME), 'x402-payments.jsonl'), {
    force: true
  });
  updateConfig({ x402_max_per_call: undefined, x402_daily_max: undefined });
});

describe('x402PriceUsd', () => {
  it('values a known stablecoin by its decimals', () => {
    expect(x402PriceUsd({ chainId: 137, asset: USDC_POLYGON, amount: 20_000n })).toBe(0.02);
  });

  it('refuses a token it cannot value', () => {
    expect(() =>
      x402PriceUsd({
        chainId: 137,
        asset: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
        amount: 1n
      })
    ).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });
});

describe('checkX402Price', () => {
  it('refuses a price over --max-usd', () => {
    expect(() => checkX402Price({ usd: 0.5, maxUsd: 0.1, url, now: NOW })).toThrow(
      expect.objectContaining({ code: 'x402_price_exceeds_max' })
    );
    expect(() => checkX402Price({ usd: 0.05, maxUsd: 0.1, url, now: NOW })).not.toThrow();
  });

  it('asks for confirmation over the per-call limit, unless --yes or --max-usd covers it', () => {
    expect(() => checkX402Price({ usd: 1.5, url, now: NOW })).toThrow(
      expect.objectContaining({
        code: 'confirmation_required',
        details: expect.objectContaining({ priceUsd: 1.5 })
      })
    );
    expect(() => checkX402Price({ usd: 1.5, yes: true, url, now: NOW })).not.toThrow();
    expect(() => checkX402Price({ usd: 1.5, maxUsd: 2, url, now: NOW })).not.toThrow();
    expect(() => checkX402Price({ usd: 0.99, url, now: NOW })).not.toThrow();
  });

  it('reads the limits from config.json', () => {
    updateConfig({ x402_max_per_call: 0.01 });
    expect(() => checkX402Price({ usd: 0.02, url, now: NOW })).toThrow(
      expect.objectContaining({ code: 'confirmation_required' })
    );
  });

  it('enforces the daily limit over a rolling 24 hours, even with --yes', () => {
    recordX402Payment({ walletName: 'main', url, usd: 6, now: new Date('2026-10-07T00:00:00Z') });
    recordX402Payment({ walletName: 'main', url, usd: 3, now: new Date('2026-10-07T11:00:00Z') });
    // Older than 24 hours: no longer counted.
    recordX402Payment({ walletName: 'main', url, usd: 50, now: new Date('2026-10-06T11:00:00Z') });
    expect(x402SpentLastDay(NOW)).toBe(9);
    expect(() => checkX402Price({ usd: 1.5, yes: true, url, now: NOW })).toThrow(
      expect.objectContaining({ code: 'daily_limit_exceeded' })
    );
    expect(() => checkX402Price({ usd: 0.5, url, now: NOW })).not.toThrow();
  });
});

describe('parseBazaarPayment', () => {
  const recipient = '0x1D17C0F90A0b3dFb5124C2FF56B33a0D2E202e1d';

  it('encodes exactly transfer(recipient, amount) and values that amount', () => {
    const payment = parseBazaarPayment({
      body: {
        payment_address: recipient,
        amount_usdc: 0.02,
        supported_chains: [{ chain: 'polygon', chainId: 137 }]
      }
    });
    expect(payment).toMatchObject({
      chainId: 137,
      asset: USDC_POLYGON,
      amount: 20_000n,
      usd: 0.02
    });
    expect(decodeFunctionData({ abi: erc20Abi, data: payment.data }).args).toEqual([
      recipient,
      20_000n
    ]);
  });

  it('refuses a recipient that would smuggle another transfer into the calldata', () => {
    // Left-padding this "address" used to encode transfer(attacker, attackerAmount).
    const crafted = `0x${'0'.repeat(24)}${'ab'.repeat(20)}${'ff'.repeat(32)}`;
    expect(() =>
      parseBazaarPayment({
        body: {
          payment_address: crafted,
          amount_usdc: 0.01,
          supported_chains: [{ chain: 'polygon', chainId: 137 }]
        }
      })
    ).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });

  it.each([-1, 0, Number.NaN])('refuses an amount of %s', (amount) => {
    expect(() =>
      parseBazaarPayment({
        body: {
          payment_address: recipient,
          amount_usdc: amount,
          supported_chains: [{ chain: 'polygon', chainId: 137 }]
        }
      })
    ).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });

  it('refuses a payment token it cannot value', () => {
    expect(() =>
      parseBazaarPayment({
        body: {
          payment_address: recipient,
          amount_usdc: 0.01,
          supported_chains: [{ chain: 'polygon', chainId: 137 }],
          usdc_contracts: { polygon: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619' }
        }
      })
    ).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });
});

describe('reserveX402Payment', () => {
  const spent = () => x402SpentLastDay(new Date());
  const reserve = (usd: number, fund: () => Promise<unknown> = async () => ({})) =>
    reserveX402Payment({ walletName: 'main', url, usd, yes: true, fund });

  it('counts every payment at its price, even when the signer already held the funds', async () => {
    // Two $6 payments paid from signer leftovers (no top-up): the second must not pass $10.
    await reserve(6);
    await expect(reserve(6)).rejects.toMatchObject({ code: 'daily_limit_exceeded' });
    expect(spent()).toBe(6);
  });

  it('writes the reservation before anything is sent, so a crash cannot lose it', async () => {
    let seenDuringFunding = -1;
    await reserve(0.5, async () => {
      seenDuringFunding = spent();
      return {};
    });
    expect(seenDuringFunding).toBe(0.5);
  });

  it('releases a refusal that certainly sent nothing, keeps a failure that may have', async () => {
    await expect(
      reserve(0.3, async () => {
        throw new CliError({ code: 'insufficient_balance', message: 'no' });
      })
    ).rejects.toThrow('no');
    expect(spent()).toBe(0);
    await expect(
      reserve(0.3, async () => {
        throw new Error('timeout');
      })
    ).rejects.toThrow('timeout');
    expect(spent()).toBe(0.3);
  });

  it('the caller releases a reservation once the service certainly was not paid', async () => {
    const { reservationId } = await reserve(0.4);
    expect(spent()).toBe(0.4);
    releaseX402Reservation(reservationId);
    expect(spent()).toBe(0);
  });

  it('checks the limits before reserving or sending', async () => {
    let funded = false;
    await expect(
      reserveX402Payment({
        walletName: 'main',
        url,
        usd: 2,
        fund: async () => {
          funded = true;
        }
      })
    ).rejects.toMatchObject({ code: 'confirmation_required' });
    expect(funded).toBe(false);
    expect(spent()).toBe(0);
  });

  it('runs one payment at a time, so two cannot both pass the daily limit', async () => {
    updateConfig({ x402_daily_max: 1 });
    const slow = () =>
      withX402Lock({ fn: () => reserve(0.6, () => new Promise((r) => setTimeout(r, 50))) });
    const results = await Promise.allSettled([slow(), slow()]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(spent()).toBe(0.6);
  });
});

describe('parseBazaarPayment with --chain', () => {
  const body = {
    payment_address: '0x1D17C0F90A0b3dFb5124C2FF56B33a0D2E202e1d',
    amount_usdc: 0.01,
    supported_chains: [
      { chain: 'polygon', chainId: 137 },
      { chain: 'base', chainId: 8453 }
    ],
    usdc_contracts: { base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }
  };

  it('pays on the chain asked for', () => {
    expect(parseBazaarPayment({ body, chainId: 8453 })).toMatchObject({ chainId: 8453 });
  });

  it('refuses a chain the service does not take', () => {
    expect(() => parseBazaarPayment({ body, chainId: 42161 })).toThrow(
      expect.objectContaining({ code: 'invalid_input' })
    );
  });
});

describe('pending authorizations', () => {
  it('sums unexpired ones for the same chain and asset', () => {
    const now = new Date();
    const later = new Date(now.getTime() + 60_000);
    markAuthorizationPending({
      id: 'a',
      chainId: 137,
      asset: USDC_POLYGON,
      amount: 400n,
      until: later
    });
    markAuthorizationPending({
      id: 'b',
      chainId: 137,
      asset: USDC_POLYGON,
      amount: 100n,
      until: later
    });
    markAuthorizationPending({
      id: 'c',
      chainId: 8453,
      asset: USDC_POLYGON,
      amount: 999n,
      until: later
    });
    markAuthorizationPending({
      id: 'd',
      chainId: 137,
      asset: USDC_POLYGON,
      amount: 999n,
      until: new Date(now.getTime() - 1)
    });
    expect(pendingAuthorizations({ chainId: 137, asset: USDC_POLYGON, now })).toBe(500n);
  });

  it('stops counting one the service confirmed', () => {
    const now = new Date();
    markAuthorizationPending({
      id: 'e',
      chainId: 137,
      asset: USDC_POLYGON,
      amount: 400n,
      until: new Date(now.getTime() + 60_000)
    });
    settleAuthorizationPending('e');
    expect(pendingAuthorizations({ chainId: 137, asset: USDC_POLYGON, now })).toBe(0n);
  });
});

describe('signedAuthorization', () => {
  it('reads the signed amount and expiry', () => {
    expect(
      signedAuthorization({
        payload: { authorization: { value: '800', validBefore: '1800000000' }, signature: '0x' }
      })
    ).toEqual({ amount: 800n, validBefore: new Date(1_800_000_000_000) });
  });

  it('refuses anything else', () => {
    expect(() => signedAuthorization({ payload: { permit2Authorization: {} } })).toThrow(
      expect.objectContaining({ code: 'invalid_input' })
    );
  });
});

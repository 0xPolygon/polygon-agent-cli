import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-x402-'));

const {
  checkX402Price,
  parseBazaarPayment,
  payWithinLimits,
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
      payment_address: recipient,
      amount_usdc: 0.02,
      supported_chains: [{ chain: 'polygon', chainId: 137 }]
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
        payment_address: crafted,
        amount_usdc: 0.01,
        supported_chains: [{ chain: 'polygon', chainId: 137 }]
      })
    ).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });

  it.each([-1, 0, Number.NaN])('refuses an amount of %s', (amount) => {
    expect(() =>
      parseBazaarPayment({
        payment_address: recipient,
        amount_usdc: amount,
        supported_chains: [{ chain: 'polygon', chainId: 137 }]
      })
    ).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });

  it('refuses a payment token it cannot value', () => {
    expect(() =>
      parseBazaarPayment({
        payment_address: recipient,
        amount_usdc: 0.01,
        supported_chains: [{ chain: 'polygon', chainId: 137 }],
        usdc_contracts: { polygon: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619' }
      })
    ).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });
});

describe('payWithinLimits', () => {
  const spent = () => x402SpentLastDay(new Date());

  it('logs a payment once the wallet paid', async () => {
    await payWithinLimits({
      walletName: 'main',
      url,
      usd: 0.5,
      pay: async () => ({ txHash: '0xpaid' })
    });
    expect(spent()).toBe(0.5);
  });

  it('logs only what left the wallet when the signer already held part of it', async () => {
    await payWithinLimits({
      walletName: 'main',
      url,
      usd: 0.5,
      pay: async () => ({ txHash: undefined, fundedUsd: 0 })
    });
    expect(spent()).toBe(0);
    await payWithinLimits({
      walletName: 'main',
      url,
      usd: 0.5,
      pay: async () => ({ txHash: '0xpart', fundedUsd: 0.2 })
    });
    expect(spent()).toBe(0.2);
  });

  it('checks the limits before paying', async () => {
    const pay = async () => ({ txHash: '0x' });
    await expect(payWithinLimits({ walletName: 'main', url, usd: 2, pay })).rejects.toMatchObject({
      code: 'confirmation_required'
    });
    expect(spent()).toBe(0);
  });

  it('does not log a refusal that sent nothing, but logs a failure that may have paid', async () => {
    await expect(
      payWithinLimits({
        walletName: 'main',
        url,
        usd: 0.3,
        pay: async () => {
          throw new CliError({ code: 'insufficient_balance', message: 'no' });
        }
      })
    ).rejects.toThrow('no');
    expect(spent()).toBe(0);
    await expect(
      payWithinLimits({
        walletName: 'main',
        url,
        usd: 0.3,
        pay: async () => {
          throw new Error('timeout');
        }
      })
    ).rejects.toThrow('timeout');
    expect(spent()).toBe(0.3);
  });

  it('runs one payment at a time, so two cannot both pass the daily limit', async () => {
    updateConfig({ x402_daily_max: 1 });
    const slow = () =>
      payWithinLimits({
        walletName: 'main',
        url,
        usd: 0.6,
        pay: () => new Promise<{ txHash: string }>((r) => setTimeout(() => r({ txHash: '0x' }), 50))
      });
    const results = await Promise.allSettled([slow(), slow()]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(spent()).toBe(0.6);
  });
});

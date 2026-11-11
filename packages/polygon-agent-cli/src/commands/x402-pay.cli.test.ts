import type { PaymentRequirements } from '@x402/core/types';

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FakeBuilder } from '../test-harness/fake-builder.ts';
import type { FakeX402 } from '../test-harness/fake-x402.ts';

import {
  cleanupHarness,
  makeHome,
  resetTripwire,
  runCli,
  tripwireHits
} from '../test-harness/cli.ts';
import { startFakeBuilder } from '../test-harness/fake-builder.ts';
import { startFakeX402 } from '../test-harness/fake-x402.ts';

// Polygon USDC, as in the CLI's own token table.
const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

let builder!: FakeBuilder;
let service!: FakeX402;

beforeAll(async () => {
  builder = await startFakeBuilder();
  service = await startFakeX402();
});

afterAll(async () => {
  await builder.close();
  await service.close();
  await cleanupHarness();
});

function accept(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'eip155:137',
    asset: USDC,
    amount: '1000',
    payTo: `0x${randomBytes(20).toString('hex')}`,
    maxTimeoutSeconds: 60,
    extra: { name: 'USD Coin', version: '2' },
    ...overrides
  };
}

// State the command needs: a Builder signer from `setup`, and a wallet pointer
// (throwaway values; shape follows OmsWalletPointer in lib/storage.ts).
async function seedState(): Promise<{ home: string; signer: string }> {
  const home = makeHome();
  const setup = await runCli({
    args: ['setup'],
    env: { SEQUENCE_BUILDER_API_URL: builder.url },
    home
  });
  expect(setup.exitCode).equal(0);
  const pointerPath = path.join(home, 'wallets', 'main.json');
  fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
  fs.mkdirSync(path.join(home, 'oms', 'main'), { recursive: true });
  fs.writeFileSync(path.join(home, 'oms', 'main', 'session.json'), '{}');
  fs.writeFileSync(
    pointerPath,
    JSON.stringify({
      walletAddress: `0x${randomBytes(20).toString('hex')}`,
      loginMethod: 'email',
      createdAt: new Date().toISOString()
    })
  );
  const stored = JSON.parse(fs.readFileSync(path.join(home, 'builder.json'), 'utf8'));
  return { home, signer: stored.eoaAddress };
}

describe('agent x402-pay', { timeout: 60_000 }, () => {
  it('previews by default: names the price, sends no payment, writes no payment log', async () => {
    const { home, signer } = await seedState();
    resetTripwire();
    service.requests.length = 0;
    service.answer({ kind: 'payment-required', accepts: [accept()] });

    const result = await runCli({ args: ['x402-pay', '--url', `${service.url}/paid`], home });

    expect(result.exitCode).equal(0);
    expect(result.stderr).equal('');
    expect(result.stdoutJson).property('ok').equal(true);
    expect(result.stdoutJson).property('dryRun').equal(true);
    expect(result.stdoutJson).property('signerAddress').equal(signer);
    expect(result.stdoutJson).property('payment').property('asset').equal(USDC);
    expect(result.stdoutJson).property('payment').property('amount').equal('1000');
    expect(result.stdoutJson).property('priceUsd').equal(0.001);
    expect(result.stdoutJson).nested.property('transactions[0].to').equal(USDC);
    // The one transaction is an ERC-20 transfer of the asked amount to the signer.
    const word = (hex: string) => hex.toLowerCase().padStart(64, '0');
    expect(result.stdoutJson).property('transactions').length(1);
    expect(result.stdoutJson)
      .nested.property('transactions[0].data')
      .equal(`0xa9059cbb${word(signer.slice(2))}${word((1000).toString(16))}`);
    expect(service.requests).length(1);
    expect(service.requests[0]).not.property('payment-signature');
    expect(service.requests[0]).not.property('x-payment');
    expect(fs.existsSync(path.join(home, 'x402-payments.jsonl'))).equal(false);
    expect(tripwireHits()).deep.equal([]);
  });

  it('passes a free answer through without paying', async () => {
    const { home } = await seedState();
    resetTripwire();
    service.requests.length = 0;
    service.answer({ kind: 'ok', body: { hello: 'world' } });

    const result = await runCli({ args: ['x402-pay', '--url', `${service.url}/free`], home });

    expect(result.exitCode).equal(0);
    expect(result.stdoutJson).deep.equal({ ok: true, status: 200, data: { hello: 'world' } });
    expect(service.requests).length(1);
    expect(fs.existsSync(path.join(home, 'x402-payments.jsonl'))).equal(false);
    expect(tripwireHits()).deep.equal([]);
  });

  it('refuses a redirect with upstream_error and pays nothing', async () => {
    const { home } = await seedState();
    resetTripwire();
    service.requests.length = 0;
    service.answer({ kind: 'redirect', location: 'http://other.test/elsewhere' });

    const result = await runCli({ args: ['x402-pay', '--url', `${service.url}/moved`], home });

    expect(result.exitCode).equal(1);
    expect(result.stdout).equal('');
    expect(result.stderrJson).property('code').equal('upstream_error');
    expect(service.requests).length(1);
    expect(fs.existsSync(path.join(home, 'x402-payments.jsonl'))).equal(false);
    expect(tripwireHits()).deep.equal([]);
  });

  it('refuses an offer it cannot sign with invalid_input and pays nothing', async () => {
    const { home } = await seedState();
    resetTripwire();
    service.requests.length = 0;
    service.answer({ kind: 'payment-required', accepts: [accept({ scheme: 'upto' })] });

    const result = await runCli({ args: ['x402-pay', '--url', `${service.url}/paid`], home });

    expect(result.exitCode).equal(1);
    expect(result.stderrJson).property('code').equal('invalid_input');
    expect(service.requests).length(1);
    expect(fs.existsSync(path.join(home, 'x402-payments.jsonl'))).equal(false);
    expect(tripwireHits()).deep.equal([]);
  });

  it('rejects an invalid --max-usd before contacting the service', async () => {
    resetTripwire();
    service.requests.length = 0;
    const result = await runCli({
      args: ['x402-pay', '--url', `${service.url}/paid`, '--max-usd=-1']
    });

    expect(result.exitCode).equal(1);
    expect(result.stdout).equal('');
    expect(result.stderrJson).property('code').equal('invalid_input');
    expect(service.requests).deep.equal([]);
    expect(tripwireHits()).deep.equal([]);
  });
});

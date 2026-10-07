// x402-pay's standard path end to end, against a fake service: what it
// funds, what it reports as paid, and what stays counted against the daily
// limit.

import type { SelectPaymentRequirements } from '@x402/core/client';
import type * as X402Fetch from '@x402/fetch';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Storage from '../lib/storage.ts';
import type * as Guard from '../lib/x402-guard.ts';

const fake = vi.hoisted(() => ({
  runTx: vi.fn(),
  paidFetch: vi.fn(),
  // The payment selector the command hands the x402 client, and the offers.
  selector: undefined as undefined | SelectPaymentRequirements,
  accepts: [] as unknown[],
  signerBalance: 0n,
  home: ''
}));

vi.mock('../lib/storage.ts', async (importOriginal) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  fake.home = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-x402-cmd-'));
  return {
    ...(await importOriginal<typeof Storage>()),
    STORAGE_ROOT: fake.home,
    loadOmsWalletPointer: vi.fn(async () => ({
      walletAddress: '0xd384ea24ca0B3a5e4BB35935C611E3dCB68Fd08e',
      loginMethod: 'email',
      createdAt: 'x',
      access: 'session'
    })),
    loadBuilderConfig: vi.fn(async () => ({
      privateKey: `0x${'11'.repeat(32)}`,
      accessKey: 'k'
    }))
  };
});
vi.mock('../lib/builder-provision.ts', () => ({ ensureBuilderAccess: async () => undefined }));
vi.mock('../lib/tx-dispatch.ts', () => ({ runTx: fake.runTx }));
vi.mock('../lib/x402-guard.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Guard>()),
  readTokenBalance: async () => fake.signerBalance,
  waitForSignerFunds: async () => undefined
}));
vi.mock('@x402/fetch', async (importOriginal) => {
  const real = await importOriginal<typeof X402Fetch>();
  class CapturingClient extends real.x402Client {
    constructor(...args: ConstructorParameters<typeof real.x402Client>) {
      super(...args);
      if (typeof args[0] === 'function') fake.selector = args[0];
    }
  }
  return {
    ...real,
    x402Client: CapturingClient,
    // As the library does: choose (and sign) an offer, then send.
    wrapFetchWithPayment:
      () =>
      async (...args: unknown[]) => {
        // Test offers are plain objects shaped like the library's requirements.
        fake.selector?.(2, fake.accepts as Parameters<SelectPaymentRequirements>[1]);
        return fake.paidFetch(...args);
      }
  };
});
vi.mock('../ui/render.js', () => ({ isTTY: () => false, inkRender: vi.fn() }));

const { x402PayCommand } = await import('./operations.ts');
const { x402SpentLastDay } = await import('../lib/x402-guard.ts');

const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const PAY_TO = '0xfd13b3f3f876e100898b72f06a500b5a9e9d1f9c';
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

const exact = (
  amount: string,
  extra: Record<string, unknown> = { name: 'USD Coin', version: '2' }
) => ({
  scheme: 'exact',
  network: 'eip155:137',
  amount,
  asset: USDC,
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra
});

function serviceAsks(accepts: unknown[]) {
  fake.accepts = accepts;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('{}', {
          status: 402,
          headers: {
            'PAYMENT-REQUIRED': b64({
              x402Version: 2,
              accepts,
              resource: { url: 'https://svc', description: '', mimeType: 'application/json' }
            })
          }
        })
    )
  );
}

async function pay(): Promise<Record<string, unknown>> {
  if (typeof x402PayCommand.handler !== 'function') throw new Error('no handler');
  await Promise.resolve(
    x402PayCommand.handler({ _: [], $0: 'polygon-agent', url: 'https://svc/data', method: 'GET' })
  ).catch(() => undefined);
  // The command's own output, in call order; a mocked process.exit then adds
  // a second line.
  const calls = [vi.mocked(console.log).mock, vi.mocked(console.error).mock].flatMap((mock) =>
    mock.calls.map((call, i) => ({ line: String(call[0]), order: mock.invocationCallOrder[i] }))
  );
  const out = calls
    .sort((a, b) => a.order - b.order)
    .map((call) => call.line)
    .filter((line) => line.startsWith('{'));
  return JSON.parse(out[0] ?? '{}');
}

beforeEach(async () => {
  const fs = await import('node:fs');
  fs.rmSync(`${fake.home}/x402-payments.jsonl`, { force: true });
  fake.runTx.mockReset().mockResolvedValue({ txHash: '0xfund' });
  fake.paidFetch.mockReset();
  fake.signerBalance = 0n;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('CLI exited');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const spent = () => x402SpentLastDay(new Date());

describe('x402-pay standard path', () => {
  it('funds nothing when no offer is a plain exact transfer it can sign', async () => {
    serviceAsks([exact('100', { name: 'GatewayWalletBatched', version: '1' })]);
    expect(await pay()).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(fake.runTx).not.toHaveBeenCalled();
    expect(spent()).toBe(0);
  });

  it('a settled payment is paid and stays counted', async () => {
    serviceAsks([exact('1000')]);
    fake.paidFetch.mockResolvedValue(
      new Response('{"result":1}', {
        status: 200,
        headers: {
          'PAYMENT-RESPONSE': b64({ success: true, transaction: '0xpaid', network: 'eip155:137' })
        }
      })
    );
    expect(await pay()).toMatchObject({ ok: true, paidUsd: 0.001, data: { result: 1 } });
    expect(spent()).toBe(0.001);
  });

  it('a signed payment the service says it did not settle stays counted (it can settle later)', async () => {
    serviceAsks([exact('1000')]);
    fake.signerBalance = 1000n;
    fake.paidFetch.mockResolvedValue(
      new Response('{}', {
        status: 402,
        headers: {
          'PAYMENT-RESPONSE': b64({ success: false, transaction: '', errorReason: 'invalid' })
        }
      })
    );
    const out = await pay();
    expect(out).toMatchObject({ ok: false, paidUsd: null, paymentUncertain: true });
    expect(String(out.error)).toMatch(/can still be settled until it expires/);
    expect(spent()).toBe(0.001);
  });

  it('a paid request that fails in flight is reported as uncertain and stays counted', async () => {
    serviceAsks([exact('1000')]);
    fake.paidFetch.mockRejectedValue(new Error('socket hang up'));
    const out = await pay();
    expect(String(out.error)).toMatch(/may or may not have reached the service/);
    expect(spent()).toBe(0.001);
  });

  it('a refused offer on the paid request is certainly unpaid', async () => {
    serviceAsks([exact('1000')]);
    fake.paidFetch.mockImplementation(async () => new Response('{}', { status: 200 }));
    // The service now asks more than was valued: nothing is signed.
    fake.accepts = [exact('5000')];
    const out = await pay();
    expect(String(out.error)).toMatch(/failed before paying/);
    expect(spent()).toBe(0);
  });

  it('a fresh 402 after signing stays counted, whatever the signer still holds', async () => {
    serviceAsks([exact('1000')]);
    fake.paidFetch.mockResolvedValue(new Response('{}', { status: 402 }));
    // 12 left in the signer after a 6-unit settlement would look "unpaid" by balance.
    fake.signerBalance = 12_000n;
    expect(await pay()).toMatchObject({ paidUsd: null, paymentUncertain: true });
    expect(spent()).toBe(0.001);
  });

  it('skips an offer in a token it cannot value, even if cheaper, and pays the USDC one', async () => {
    serviceAsks([
      { ...exact('1'), asset: '0x0000000000000000000000000000000000000bad' },
      exact('1000')
    ]);
    fake.paidFetch.mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: {
          'PAYMENT-RESPONSE': b64({ success: true, transaction: '0xpaid', network: 'eip155:137' })
        }
      })
    );
    expect(await pay()).toMatchObject({ ok: true, paidUsd: 0.001 });
  });

  it('holds the x402 lock through the paid request, so concurrent calls cannot share leftovers', async () => {
    const fs = await import('node:fs');
    const lockDir = `${fake.home}/locks/x402.lock`;
    let heldDuringPayment = false;
    serviceAsks([exact('1000')]);
    fake.paidFetch.mockImplementation(async () => {
      heldDuringPayment = fs
        .readdirSync(lockDir)
        .some((name) => !JSON.parse(fs.readFileSync(`${lockDir}/${name}`, 'utf8')).released);
      return new Response('{}', {
        status: 200,
        headers: {
          'PAYMENT-RESPONSE': b64({ success: true, transaction: '0xpaid', network: 'eip155:137' })
        }
      });
    });
    await pay();
    expect(heldDuringPayment).toBe(true);
  });

  it('does not count on signer funds an unconfirmed authorization may still claim', async () => {
    serviceAsks([exact('1000')]);
    fake.signerBalance = 1000n;
    fake.paidFetch.mockResolvedValue(new Response('{}', { status: 402 }));
    await pay(); // signs against the leftover; the service doesn't confirm
    expect(fake.runTx).not.toHaveBeenCalled();
    vi.mocked(console.log).mockClear();
    vi.mocked(console.error).mockClear();
    await pay(); // the leftover is promised to that authorization: fund afresh
    expect(fake.runTx).toHaveBeenCalledTimes(1);
  });

  it('ranks offers by USD value across tokens with different decimals', async () => {
    const BNB_USDC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
    const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    serviceAsks([
      { ...exact('5000'), network: 'eip155:8453', asset: BASE_USDC }, // $0.005
      { ...exact('1000000000000000'), network: 'eip155:56', asset: BNB_USDC } // $0.001
    ]);
    fake.paidFetch.mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: {
          'PAYMENT-RESPONSE': b64({ success: true, transaction: '0x', network: 'eip155:56' })
        }
      })
    );
    expect(await pay()).toMatchObject({ ok: true, paidUsd: 0.001 });
    expect(fake.runTx).toHaveBeenCalledWith(expect.objectContaining({ chainId: 56 }));
  });

  it('a malformed body after a settled payment still reports the payment', async () => {
    serviceAsks([exact('1000')]);
    fake.paidFetch.mockResolvedValue(
      new Response('{not json', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'PAYMENT-RESPONSE': b64({ success: true, transaction: '0xpaid', network: 'eip155:137' })
        }
      })
    );
    expect(await pay()).toMatchObject({
      ok: true,
      paidUsd: 0.001,
      data: '{not json',
      payment: { settled: true, transaction: '0xpaid' }
    });
  });
});

describe('x402-pay bazaar path', () => {
  async function bazaar(): Promise<Record<string, unknown>> {
    if (typeof x402PayCommand.handler !== 'function') throw new Error('no handler');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              payment_address: '0x1D17C0F90A0b3dFb5124C2FF56B33a0D2E202e1d',
              amount_usdc: 0.02,
              supported_chains: [{ chain: 'polygon', chainId: 137 }]
            }),
            { status: 402 }
          )
      )
    );
    await Promise.resolve(
      x402PayCommand.handler({
        _: [],
        $0: 'polygon-agent',
        url: 'https://x402-api.onrender.com/api/x',
        method: 'GET'
      })
    ).catch(() => undefined);
    const line = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .find((l) => l.startsWith('{'));
    return JSON.parse(line ?? '{}');
  }

  it('keeps the reservation when the payment transfer was recorded before an error', async () => {
    const { CliError } = await import('../lib/errors.ts');
    const { sessionDir, writeJsonFile } = await import('../lib/session/state.ts');
    const fs = await import('node:fs');
    fake.runTx.mockImplementation(async () => {
      // Executed, then polling it hit a revoked key.
      const dir = `${sessionDir('main')}/transfers`;
      fs.mkdirSync(dir, { recursive: true });
      writeJsonFile({
        file: `${dir}/paid.json`,
        data: {
          id: `paid-${Date.now()}`,
          state: 'uncertain',
          chainId: 137,
          token: USDC,
          symbol: 'USDC',
          to: '0x1D17C0F90A0b3dFb5124C2FF56B33a0D2E202e1d',
          amount: '20000',
          usd: 0.02,
          purpose: 'x402',
          walletId: 'w',
          sessionId: 's',
          ledgered: false,
          createdAt: 'x',
          updatedAt: 'x'
        }
      });
      throw new CliError({ code: 'session_revoked', message: 'revoked' });
    });
    expect(await bazaar()).toMatchObject({ code: 'session_revoked' });
    expect(spent()).toBe(0.02);
  });

  it('a lost answer after paying keeps the payment details, so nobody pays again', async () => {
    fake.runTx.mockResolvedValue({ txHash: '0xpaidtx' });
    let call = 0;
    const out = await (async () => {
      if (typeof x402PayCommand.handler !== 'function') throw new Error('no handler');
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown) => {
          call += 1;
          if (call === 1) {
            return new Response(
              JSON.stringify({
                payment_address: '0x1D17C0F90A0b3dFb5124C2FF56B33a0D2E202e1d',
                amount_usdc: 0.02,
                supported_chains: [{ chain: 'polygon', chainId: 137 }]
              }),
              { status: 402 }
            );
          }
          // RPC receipt polling succeeds; the paid request itself is reset.
          if (String(input).includes('x402-api')) throw new Error('ECONNRESET');
          return new Response(JSON.stringify({ result: { status: '0x1' } }));
        })
      );
      vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1000 });
      await Promise.resolve(
        x402PayCommand.handler({
          _: [],
          $0: 'polygon-agent',
          url: 'https://x402-api.onrender.com/api/x',
          method: 'GET'
        })
      ).catch(() => undefined);
      vi.useRealTimers();
      const line = vi
        .mocked(console.error)
        .mock.calls.map((c) => String(c[0]))
        .find((l) => l.startsWith('{'));
      return JSON.parse(line ?? '{}');
    })();
    expect(out).toMatchObject({
      ok: false,
      paidUsd: 0.02,
      funded: { txHash: '0xpaidtx' },
      retryHeaders: { 'X-Payment-TxHash': '0xpaidtx' }
    });
    expect(String(out.error)).toMatch(/Don't pay again/);
  });

  it('releases the reservation when a check refused it before any transfer', async () => {
    const { CliError } = await import('../lib/errors.ts');
    fake.runTx.mockRejectedValue(new CliError({ code: 'allowance_exhausted', message: 'limit' }));
    expect(await bazaar()).toMatchObject({ code: 'allowance_exhausted' });
    expect(spent()).toBe(0);
  });
});

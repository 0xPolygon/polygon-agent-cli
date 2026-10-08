import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runTx: vi.fn(),
  loadOmsWalletPointer: vi.fn(),
  loadBuilderConfig: vi.fn(),
  wrapFetchWithPayment: vi.fn()
}));

vi.mock('../lib/storage.ts', () => ({
  loadOmsWalletPointer: mocks.loadOmsWalletPointer,
  loadBuilderConfig: mocks.loadBuilderConfig
}));

vi.mock('../lib/tx-dispatch.ts', () => ({
  runTx: mocks.runTx
}));

vi.mock('viem/accounts', () => ({
  privateKeyToAccount: () => ({
    address: '0x1111111111111111111111111111111111111111'
  })
}));

vi.mock('@x402/evm', () => ({
  ExactEvmScheme: class {}
}));

vi.mock('@x402/fetch', () => {
  class MockX402Client {
    register() {}
  }

  class MockX402HTTPClient {
    getPaymentRequiredResponse() {
      return {
        x402Version: 2,
        accepts: [
          {
            amount: '1000',
            asset: '0x2222222222222222222222222222222222222222',
            network: 'eip155:137',
            extra: {}
          }
        ]
      };
    }
  }

  return {
    x402Client: MockX402Client,
    x402HTTPClient: MockX402HTTPClient,
    wrapFetchWithPayment: mocks.wrapFetchWithPayment,
    decodePaymentResponseHeader: vi.fn()
  };
});

import { x402PayCommand } from './operations.ts';

describe('x402-pay transaction mode', () => {
  beforeEach(() => {
    mocks.runTx.mockReset();
    mocks.wrapFetchWithPayment.mockReset();
    mocks.loadOmsWalletPointer.mockResolvedValue({
      walletAddress: '0x3333333333333333333333333333333333333333'
    });
    mocks.loadBuilderConfig.mockResolvedValue({
      privateKey: '0x' + '11'.repeat(32)
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('exposes the shared broadcast and dry-run flags', () => {
    const options: string[] = [];
    const yargs = {
      option(name: string) {
        options.push(name);
        return this;
      }
    };

    (x402PayCommand.builder as (y: unknown) => unknown)(yargs);

    expect(options).toContain('broadcast');
    expect(options).toContain('dry-run');
  });

  it('does not fund or pay a standard x402 request in dry-run mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('', {
        status: 402
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await x402PayCommand.handler?.({
      _: [],
      $0: 'agent',
      wallet: 'main',
      url: 'https://example.com/protected',
      method: 'GET',
      dryRun: true
    } as never);

    expect(mocks.runTx).not.toHaveBeenCalled();
    expect(mocks.wrapFetchWithPayment).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const preview = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(preview).toMatchObject({
      ok: true,
      dryRun: true,
      payment: {
        format: 'x402',
        amount: '1000',
        network: 'eip155:137',
        chainId: 137
      }
    });
  });

  it('does not send the Bazaar payment transaction in dry-run mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          payment_address: '0x4444444444444444444444444444444444444444',
          amount_usdc: 0.001,
          supported_chains: [{ chain: 'polygon', chainId: 137 }],
          usdc_contracts: {
            polygon: '0x5555555555555555555555555555555555555555'
          }
        }),
        {
          status: 402,
          headers: { 'content-type': 'application/json' }
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await x402PayCommand.handler?.({
      _: [],
      $0: 'agent',
      wallet: 'main',
      url: 'https://x402-api.onrender.com/protected',
      method: 'GET',
      dryRun: true
    } as never);

    expect(mocks.runTx).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const preview = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(preview).toMatchObject({
      ok: true,
      dryRun: true,
      payment: {
        format: 'bazaar',
        chain: 'polygon',
        chainId: 137,
        amount: 0.001
      }
    });
  });
});

// waitForSignerFunds against a fake chain: an earlier authorization settling
// while the top-up confirms must not turn a funded payment into a timeout.

import type * as Viem from 'viem';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const chain = vi.hoisted(() => ({
  balance: 0n,
  mined: false,
  // The token's Transfer events in the funding receipt.
  logs: [] as unknown[]
}));

vi.mock('viem', async (importOriginal) => ({
  ...(await importOriginal<typeof Viem>()),
  createPublicClient: () => ({
    readContract: async () => chain.balance,
    getTransactionReceipt: async () => {
      if (!chain.mined) throw new Error('not found');
      return { status: 'success', logs: chain.logs };
    }
  })
}));

const { waitForSignerFunds } = await import('./x402-guard.ts');
const { encodeAbiParameters, encodeEventTopics, erc20Abi } = await import('viem');

function transferLog(params: { token: string; to: `0x${string}`; value: bigint }) {
  return {
    address: params.token,
    topics: encodeEventTopics({
      abi: erc20Abi,
      eventName: 'Transfer',
      args: { from: '0x0000000000000000000000000000000000000001', to: params.to }
    }),
    data: encodeAbiParameters([{ type: 'uint256' }], [params.value]),
    blockNumber: 1n,
    logIndex: 0,
    transactionIndex: 0,
    transactionHash: `0x${'ab'.repeat(32)}`,
    blockHash: `0x${'cd'.repeat(32)}`,
    removed: false
  };
}

const params = {
  chainId: 137,
  token: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' as const,
  owner: '0x8bF5E38190E2230F2BAe8280eb4901F922920676' as const,
  // 20,000 promised to an earlier authorization, plus this payment's 20,000.
  atLeast: 40_000n,
  funding: { txHash: `0x${'ab'.repeat(32)}`, amount: 20_000n, enough: 20_000n },
  timeoutMs: 3_000
};

beforeEach(() => {
  chain.balance = 0n;
  chain.mined = false;
  chain.logs = [];
});

describe('waitForSignerFunds', () => {
  it('accepts a mined top-up after an earlier authorization took its own share', async () => {
    // The top-up landed and the earlier authorization settled meanwhile.
    chain.balance = 20_000n;
    chain.mined = true;
    chain.logs = [transferLog({ token: params.token, to: params.owner, value: 20_000n })];
    await expect(waitForSignerFunds(params)).resolves.toBeUndefined();
  }, 10_000);

  it("a mined transaction whose transfer to the signer didn't happen proves nothing", async () => {
    // The relayed wallet call succeeded, but its inner transfer moved nothing.
    chain.balance = 30_000n;
    chain.mined = true;
    await expect(waitForSignerFunds({ ...params, atLeast: 50_000n })).rejects.toMatchObject({
      code: 'upstream_unavailable'
    });
  }, 10_000);

  it("doesn't count promised funds while the top-up isn't mined", async () => {
    chain.balance = 20_000n;
    await expect(waitForSignerFunds(params)).rejects.toMatchObject({
      code: 'upstream_unavailable'
    });
  }, 10_000);
});

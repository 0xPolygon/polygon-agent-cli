import { decodeFunctionData, erc20Abi } from 'viem';
import { describe, expect, it } from 'vitest';

import { reconcileTransfers, spentUsdSince, transfer } from './engine.ts';
import { MoneyError } from './errors.ts';
import { fakeEngine, httpError, START, TO, USDC, WETH } from './test-fakes.ts';

const send = (fake: ReturnType<typeof fakeEngine>, amount: bigint, token = USDC) =>
  transfer({ chainId: 137, token, to: TO, amount, purpose: 'send', deps: fake.deps });

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (error) {
    if (error instanceof MoneyError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('transfer', () => {
  it('prepares exactly the transfer asked for, executes it and counts it', async () => {
    const fake = fakeEngine();
    const result = await send(fake, 1_500_000n);
    expect(result).toMatchObject({ txHash: '0xhash', txnId: 'txn-1', usd: 1.5 });
    expect(fake.calls).toMatchObject({ prepare: 1, execute: 1 });
    const call = fake.calls.prepared[0];
    expect(call.to).toBe(USDC);
    expect(decodeFunctionData({ abi: erc20Abi, data: call.data as `0x${string}` })).toMatchObject({
      functionName: 'transfer',
      args: [TO, 1_500_000n]
    });
    const records = [...fake.transfers.values()];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ state: 'executed', txHash: '0xhash', usd: 1.5 });
    expect(spentUsdSince({ transfers: records, since: START.toISOString() })).toBe(1.5);
  });

  it('refuses what would take the total past the USD allowance, across tokens', async () => {
    const fake = fakeEngine();
    await send(fake, 60_000_000n);
    // 0.02 WETH at $2,500 is $50: $110 in all, past $100.
    expect(await code(send(fake, 20_000_000_000_000_000n, WETH))).toBe('allowance_exhausted');
    expect(fake.calls.prepare).toBe(1);
  });

  it('refuses more than the on-chain limit has left', async () => {
    const fake = fakeEngine({ used: 99_000_000n });
    expect(await code(send(fake, 2_000_000n))).toBe('allowance_exhausted');
    expect(fake.calls.prepare).toBe(0);
  });

  it('refuses more than the wallet holds', async () => {
    const fake = fakeEngine({ balance: 1_000_000n });
    expect(await code(send(fake, 2_000_000n))).toBe('insufficient_balance');
  });

  it("refuses a token the allowance doesn't cover", async () => {
    const fake = fakeEngine();
    const WBTC = '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6';
    expect(await code(send(fake, 1n, WBTC))).toBe('not_covered');
  });

  it('refuses without an approved allowance', async () => {
    const fake = fakeEngine();
    fake.unapprove();
    expect(await code(send(fake, 1n))).toBe('not_connected');
  });

  it("records a transfer OMS won't sponsor as never sent", async () => {
    const fake = fakeEngine({ sponsored: false });
    expect(await code(send(fake, 1_000_000n))).toBe('not_sponsored');
    expect(fake.calls.execute).toBe(0);
    expect([...fake.transfers.values()][0]).toMatchObject({ state: 'failed', neverSent: true });
  });

  it('maps a used-up on-chain limit to allowance_exhausted', async () => {
    const fake = fakeEngine({ prepareError: httpError(400, 'UsageLimitExceeded') });
    expect(await code(send(fake, 1_000_000n))).toBe('allowance_exhausted');
  });

  it('reads a refused key as revoked', async () => {
    const fake = fakeEngine({ prepareError: httpError(401) });
    expect(await code(send(fake, 1_000_000n))).toBe('session_revoked');
  });

  it('never resends a transfer whose execute may have gone through', async () => {
    const fake = fakeEngine({
      executeError: new Error('network down'),
      statuses: [{ status: 'pending' }]
    });
    expect(await code(send(fake, 1_000_000n))).toBe('upstream_unavailable');
    expect([...fake.transfers.values()][0].state).toBe('uncertain');

    // Until it settles, nothing new starts.
    fake.state.executeError = undefined;
    expect(await code(send(fake, 1_000_000n))).toBe('upstream_unavailable');
    expect(fake.calls.prepare).toBe(1);

    // Once OMS says it went through, it counts and the next transfer goes.
    fake.state.statuses = [{ status: 'executed', txnHash: '0xfirst' }];
    await reconcileTransfers(fake.deps);
    const [first] = [...fake.transfers.values()];
    expect(first).toMatchObject({ state: 'executed', txHash: '0xfirst' });
    await send(fake, 1_000_000n);
    expect(fake.calls.prepare).toBe(2);
  });

  it("won't send after a quote's deadline", async () => {
    const fake = fakeEngine();
    const result = transfer({
      chainId: 137,
      token: USDC,
      to: TO,
      amount: 1n,
      purpose: 'trade',
      notAfter: START.getTime() - 1,
      deps: fake.deps
    });
    expect(await code(result)).toBe('quote_expired');
    expect(fake.calls.prepare).toBe(0);
  });
});

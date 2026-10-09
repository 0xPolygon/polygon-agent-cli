// Owner mode: a deadline (a trade quote's expiry) is checked after the SDK has
// prepared the transaction, right before it executes.

import { describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ executed: 0, prepareMs: 0 }));

vi.mock('./oms-client.ts', () => ({
  getOmsClient: () => ({
    wallet: {
      walletAddress: '0xd384ea24ca0B3a5e4BB35935C611E3dCB68Fd08e',
      // Like the SDK: prepare, then ask for a fee option (also when sponsored),
      // then execute.
      sendTransaction: async (params: { selectFeeOption: (options: unknown[]) => unknown }) => {
        await new Promise((resolve) => setTimeout(resolve, fake.prepareMs));
        await params.selectFeeOption([]);
        fake.executed += 1;
        return { txnHash: '0xsent' };
      }
    }
  })
}));

vi.mock('./storage.ts', () => ({ loadOmsWalletPointer: async () => null }));

const { runOmsTx } = await import('./oms-tx.ts');

const tx = { to: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', data: '0x', value: 0n };

describe('runOmsTx notAfter', () => {
  it('does not execute when the deadline passes while preparing', async () => {
    fake.executed = 0;
    fake.prepareMs = 50;
    await expect(
      runOmsTx({
        walletName: 'main',
        chainId: 137,
        transactions: [tx],
        broadcast: true,
        notAfter: Date.now() + 10
      })
    ).rejects.toMatchObject({ code: 'quote_expired' });
    expect(fake.executed).toBe(0);
  });

  it('executes within the deadline', async () => {
    fake.executed = 0;
    fake.prepareMs = 0;
    expect(
      await runOmsTx({
        walletName: 'main',
        chainId: 137,
        transactions: [tx],
        broadcast: true,
        notAfter: Date.now() + 60_000
      })
    ).toMatchObject({ txHash: '0xsent' });
    expect(fake.executed).toBe(1);
  });
});

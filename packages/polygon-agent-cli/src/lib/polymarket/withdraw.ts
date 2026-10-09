// Moving pUSD out of a Polymarket account: a gasless pUSD transfer to a Polymarket
// bridge address bound to the recipient, which pays the recipient USDC on Polygon.
// Shared by `polymarket withdraw` and by recovery, which sweeps an old account.

import type { SecureClient } from './account.ts';

import { formatUnits6 } from './amounts.ts';
import { withdrawAddress } from './bridge.ts';
import { PolymarketError, PUSD } from './gamma.ts';
import { loadSdk, mapSdkError } from './sdk.ts';

// Refreshes the CLOB's cached view first: a plain fetch can lag a deposit or a fill.
export async function pusdBalanceOf(client: SecureClient): Promise<bigint> {
  const { root, actions } = await loadSdk();
  try {
    const res = await actions.updateBalanceAllowance(client, {
      assetType: root.AssetType.COLLATERAL
    } as never);
    return BigInt(res.balance);
  } catch (err) {
    throw mapSdkError(err);
  }
}

export function assertWithdrawable(amount: bigint, balance: bigint): void {
  if (amount === 0n || amount > balance) {
    throw new PolymarketError(
      'insufficient_pusd',
      `The Polymarket wallet holds $${formatUnits6(balance)} pUSD.`
    );
  }
}

// The bridge address that pays `recipient` USDC on Polygon for pUSD sent from `account`.
export function withdrawRoute(p: { account: string; recipient: string }): Promise<string> {
  return withdrawAddress({ wallet: p.account, recipient: p.recipient });
}

export async function sendWithdraw(
  client: SecureClient,
  p: { amount: bigint; via: string }
): Promise<{ txHash: string }> {
  const handle = await client.transferErc20({
    amount: p.amount,
    recipientAddress: p.via,
    tokenAddress: PUSD
  });
  const outcome = await handle.wait();
  return { txHash: outcome.transactionHash };
}

export type WithdrawAllResult = {
  amount: bigint;
  amountUsd: string;
  from: string;
  to: string;
  via: string;
  dryRun?: true;
  txHash?: string;
};

// Withdraws the whole pUSD balance of `account` to `recipient`. Fails with
// insufficient_pusd on an empty account, before anything is sent.
export async function withdrawAll(p: {
  client: SecureClient;
  account: string;
  recipient: string;
  broadcast: boolean;
}): Promise<WithdrawAllResult> {
  const amount = await pusdBalanceOf(p.client);
  assertWithdrawable(amount, amount);
  const via = await withdrawRoute({ account: p.account, recipient: p.recipient });
  const plan = { amount, amountUsd: formatUnits6(amount), from: p.account, to: p.recipient, via };
  if (!p.broadcast) return { ...plan, dryRun: true };
  const { txHash } = await sendWithdraw(p.client, { amount, via });
  return { ...plan, txHash };
}

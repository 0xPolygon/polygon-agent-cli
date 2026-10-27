// Sending an approved owner action from the owner's own wallet, while they're
// signed in on the approval page: the same call the CLI makes in owner mode
// (oms-tx.ts), one transaction at a time, paying gas in USDC when it isn't
// sponsored.

import type { FeeOptionSelection, FeeOptionWithBalance, OMSWallet } from '@polygonlabs/oms-wallet';

import { findNetworkById, TransactionMode } from '@polygonlabs/oms-wallet';

import { MoneyError } from './errors.ts';

const isUsdc = (o: FeeOptionWithBalance) =>
  !!o.feeOption.token.symbol?.toUpperCase().includes('USDC');
const isNative = (o: FeeOptionWithBalance) =>
  !o.feeOption.token.contractAddress ||
  ['POL', 'ETH'].includes(o.feeOption.token.symbol?.toUpperCase() ?? '');

/** USDC first, then the native coin, among options the wallet can afford. */
export function selectFee(opts: FeeOptionWithBalance[]): FeeOptionSelection | undefined {
  if (opts.length === 0) return undefined; // sponsored
  const usable = opts.filter(
    (o) => o.availableRaw != null && BigInt(o.availableRaw) >= BigInt(o.feeOption.value)
  );
  const pick = usable.find(isUsdc) ?? usable.find(isNative) ?? usable[0];
  if (!pick) {
    throw new MoneyError({
      code: 'insufficient_balance',
      message: "The wallet can't pay this transaction's gas: it has no USDC or native coin for it."
    });
  }
  return pick.selection;
}

export async function runAsOwner(params: {
  oms: Pick<OMSWallet, 'wallet'>;
  wallet: string;
  chainId: number;
  transactions: { to: string; data: string }[];
}): Promise<{ txHashes: string[] }> {
  const w = params.oms.wallet;
  // From the agent wallet itself, never an imported one.
  const main = (await w.listWallets()).find(
    (x) => x.keyOrigin !== 'imported' && x.address.toLowerCase() === params.wallet.toLowerCase()
  );
  if (!main) {
    throw new MoneyError({
      code: 'not_connected',
      message: "That sign-in isn't the owner of this agent wallet."
    });
  }
  if (w.walletAddress?.toLowerCase() !== main.address.toLowerCase()) {
    await w.useWallet({ walletId: main.id });
  }
  const network = findNetworkById(params.chainId);
  if (!network) throw new MoneyError({ code: 'not_covered', message: 'Unsupported network.' });
  const txHashes: string[] = [];
  // Not atomic: if a later one fails, the earlier ones have landed (an approve
  // without its deposit just leaves an allowance to the vault).
  for (const tx of params.transactions) {
    const res = await w.sendTransaction({
      network,
      to: tx.to as `0x${string}`,
      data: tx.data as `0x${string}`,
      value: 0n,
      mode: TransactionMode.Relayer,
      waitForStatus: true,
      selectFeeOption: selectFee
    });
    if (res.txnHash) txHashes.push(res.txnHash);
  }
  return { txHashes };
}

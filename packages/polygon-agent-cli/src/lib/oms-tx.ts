// OMS transaction primitive — drop-in replacement for runDappClientTx.
//
// Keeps the exact same { walletName, chainId, transactions[], broadcast, preferNativeFee }
// interface and { walletAddress, txHash?, dryRun?, feeOptionUsed? } result so the
// existing command call sites need only swap which implementation they call (via
// the runTx dispatch). Internally maps onto oms.wallet.sendTransaction.

import type { FeeOptionWithBalance } from '@polygonlabs/oms-wallet';

import { findNetworkById, isOMSWalletError, TransactionMode } from '@polygonlabs/oms-wallet';

import { getOmsClient } from './oms-client.ts';

export interface OmsTxTransaction {
  to: `0x${string}` | string;
  value?: bigint | number;
  data: string;
}

export interface OmsTxParams {
  walletName: string;
  chainId: number;
  transactions: OmsTxTransaction[];
  broadcast: boolean;
  preferNativeFee?: boolean;
}

export interface OmsTxResult {
  walletAddress: string;
  txHash?: string;
  dryRun?: boolean;
  feeOptionUsed?: unknown;
}

const USDC_POLYGON = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';

// Build a selectFeeOption callback mirroring the legacy fee logic:
// prefer native gas if requested, else prefer USDC, always gated on affordability.
function makeFeeSelector(preferNativeFee: boolean) {
  return (opts: FeeOptionWithBalance[]) => {
    const usable = opts.filter(
      (o) => o.availableRaw != null && BigInt(o.availableRaw) >= BigInt(o.feeOption.value)
    );
    const isNative = (o: FeeOptionWithBalance) =>
      !o.feeOption.token.contractAddress ||
      o.feeOption.token.symbol?.toUpperCase() === 'POL' ||
      o.feeOption.token.symbol?.toUpperCase() === 'ETH';

    let pick: FeeOptionWithBalance | undefined;
    if (preferNativeFee) pick = usable.find(isNative);
    if (!pick) {
      pick =
        usable.find((o) => o.feeOption.token.contractAddress?.toLowerCase() === USDC_POLYGON) ??
        usable.find((o) => o.feeOption.token.symbol?.toUpperCase().includes('USDC')) ??
        (preferNativeFee ? undefined : usable.find(isNative)) ??
        usable[0];
    }
    if (!pick) {
      throw new Error(
        'Unable to pay gas: wallet has no native token and no usable fee token. ' +
          'Fund with POL (agent fund), or hold USDC for fees.'
      );
    }
    return { token: pick.feeOption.token.symbol };
  };
}

export async function runOmsTx(params: OmsTxParams): Promise<OmsTxResult> {
  const { walletName, chainId, transactions, broadcast, preferNativeFee = false } = params;

  const oms = getOmsClient(walletName);
  const walletAddress = oms.wallet.walletAddress;
  if (!walletAddress) {
    throw new Error(`No active session for wallet '${walletName}'. Run: agent wallet login`);
  }

  // Dry-run: print the same JSON shape the legacy primitive produced and return.
  if (!broadcast) {
    const bigintReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
    console.log(
      JSON.stringify(
        { ok: true, dryRun: true, walletName, walletAddress, transactions },
        bigintReplacer,
        2
      )
    );
    return { walletAddress, dryRun: true };
  }

  const network = findNetworkById(chainId);
  if (!network) throw new Error(`Unsupported chainId for OMS: ${chainId}`);

  const selectFeeOption = makeFeeSelector(preferNativeFee);

  // OMS sendTransaction takes a single tx. For multi-tx bundles (only `deposit`
  // sends 2: approve + supply) we submit sequentially. NON-ATOMIC: if the second
  // fails, the first has already landed. Return the last tx's hash.
  let lastTxHash: string | undefined;
  let lastFee: unknown;
  for (const tx of transactions) {
    try {
      const res = await oms.wallet.sendTransaction({
        network,
        to: tx.to as `0x${string}`,
        data: tx.data as `0x${string}`,
        value: tx.value != null ? BigInt(tx.value) : 0n,
        mode: TransactionMode.Relayer,
        waitForStatus: true,
        selectFeeOption
      });
      lastTxHash = res.txnHash ?? lastTxHash;
    } catch (e) {
      if (
        isOMSWalletError(e) &&
        (e.code === 'OMS_SESSION_EXPIRED' || e.code === 'OMS_SESSION_MISSING')
      ) {
        throw new Error(
          `Session expired or missing for wallet '${walletName}'. ` + `Run: agent wallet login`
        );
      }
      throw e;
    }
  }

  return { walletAddress, txHash: lastTxHash, feeOptionUsed: lastFee };
}

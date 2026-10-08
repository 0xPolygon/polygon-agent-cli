// OMS transaction primitive — drop-in replacement for runDappClientTx.
//
// Keeps the exact same { walletName, chainId, transactions[], broadcast, preferNativeFee }
// interface and { walletAddress, txHash?, dryRun?, feeOptionUsed? } result so the
// existing command call sites need only swap which implementation they call (via
// the runTx dispatch). Internally maps onto oms.wallet.sendTransaction.

import type { FeeOptionSelection, FeeOptionWithBalance } from '@polygonlabs/oms-wallet';

import { findNetworkById, isOMSWalletError, TransactionMode } from '@polygonlabs/oms-wallet';

import { CliError } from './errors.ts';
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
  // Don't execute after this time (ms since epoch), e.g. a trade quote's expiry.
  notAfter?: number;
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
// Sponsored transactions call it with an empty list (oms-wallet >= 0.3); returning
// undefined lets them proceed with no fee.
export function makeFeeSelector(preferNativeFee: boolean) {
  return (opts: FeeOptionWithBalance[]): FeeOptionSelection | undefined => {
    if (opts.length === 0) return undefined;
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
      // Raised before executing, so nothing was sent (insufficient_balance is in
      // NOTHING_SENT_CODES).
      throw new CliError({
        code: 'insufficient_balance',
        message: 'Unable to pay gas: wallet has no native token and no usable fee token.',
        hint: 'Fund with POL (agent fund), or hold USDC for fees.'
      });
    }
    // The SDK's selection carries the option's index, so two options with the
    // same symbol can't be confused.
    return pick.selection;
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
        {
          ok: true,
          dryRun: true,
          walletName,
          walletAddress,
          transactions,
          hint: 'Dry run only, nothing was sent. Re-run with --broadcast to execute, or enable always-broadcast with: agent mode auto'
        },
        bigintReplacer,
        2
      )
    );
    return { walletAddress, dryRun: true };
  }

  // A deadline only makes sense for one transaction: with several, an expiry
  // after the first executed would wrongly read as "nothing was sent".
  if (params.notAfter !== undefined && transactions.length !== 1) {
    throw new Error('notAfter needs exactly one transaction');
  }

  const network = findNetworkById(chainId);
  if (!network) throw new Error(`Unsupported chainId for OMS: ${chainId}`);

  // The SDK calls the fee selector after preparing and right before executing
  // (sponsored or not), so a deadline checked there is checked last.
  const feeSelector = makeFeeSelector(preferNativeFee);
  let expired = false;
  const selectFeeOption: typeof feeSelector = (options) => {
    if (params.notAfter !== undefined && Date.now() > params.notAfter) {
      expired = true;
      throw new Error('past notAfter before executing');
    }
    return feeSelector(options);
  };

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
      // The SDK wraps whatever the fee selector throws; keep our own refusal intact.
      if (e instanceof CliError) throw e;
      const cause = (e as { cause?: unknown })?.cause;
      if (cause instanceof CliError) throw cause;
      if (expired) {
        throw new CliError({
          code: 'quote_expired',
          message: 'The quote expired while preparing the transaction; nothing was sent.',
          hint: 'Quote again.'
        });
      }
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

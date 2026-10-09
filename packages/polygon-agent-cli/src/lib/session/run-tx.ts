// runTx for session-mode wallets. A session can only make ERC-20 transfers of
// covered tokens, one per call; everything else needs the owner.

import { decodeFunctionData, erc20Abi, getAddress, isAddress, isHex } from 'viem';

import type { OmsTxParams, OmsTxResult } from '../oms-tx.ts';
import type { SpendPurpose } from './ledger.ts';
import type { TransferDeps, TransferCheck } from './transfer.ts';

import { CliError, bigintReplacer } from '../errors.ts';
import { formatUnits } from '../utils.ts';
import { liveTransferDeps } from './live.ts';
import { retireParkedRacs } from './rac.ts';
import { withWalletKeys } from './renewal.ts';
import { checkTransfer, sessionTransfer } from './transfer.ts';

export interface SessionTxParams extends OmsTxParams {
  walletAddress: string;
  purpose?: SpendPurpose;
  ref?: string;
  notAfter?: number;
}

function ownerRequired(what: string): CliError {
  return new CliError({
    code: 'owner_required',
    message: `${what} needs the wallet owner; this install's allowance only covers token transfers.`
  });
}

// The single ERC-20 transfer a session can make, or a clear refusal.
export function decodeSessionTransfer(params: OmsTxParams): {
  token: `0x${string}`;
  to: `0x${string}`;
  amount: bigint;
} {
  if (params.transactions.length !== 1) {
    throw ownerRequired('A multi-step transaction');
  }
  const [tx] = params.transactions;
  if (tx.value !== undefined && BigInt(tx.value) > 0n) {
    throw new CliError({
      code: 'native_not_supported',
      message:
        "Native coins (ETH, POL, BNB, AVAX) can't be spent with this install's allowance. " +
        'Swap from a covered token instead, or ask the owner.'
    });
  }
  if (!isAddress(tx.to) || !isHex(tx.data)) throw ownerRequired('This transaction');
  let decoded: ReturnType<typeof decodeFunctionData<typeof erc20Abi>>;
  try {
    decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
  } catch {
    throw ownerRequired('This contract call');
  }
  if (decoded.functionName !== 'transfer') throw ownerRequired(`A token ${decoded.functionName}`);
  const [to, amount] = decoded.args;
  return { token: getAddress(tx.to), to: getAddress(to), amount };
}

// The checks a session transfer would run, without sending anything (dry runs
// of trades and payments).
export async function checkSessionSpend(params: {
  walletName: string;
  walletAddress: string;
  chainId: number;
  token: `0x${string}`;
  amount: bigint;
}): Promise<TransferCheck> {
  return withWalletKeys({
    wallet: params.walletName,
    fn: () =>
      checkTransfer({
        wallet: params.walletName,
        walletAddress: params.walletAddress,
        chainId: params.chainId,
        token: params.token,
        amount: params.amount,
        deps: liveTransferDeps(params.walletName)
      })
  });
}

export async function runSessionTx(
  params: SessionTxParams,
  injected?: TransferDeps
): Promise<OmsTxResult> {
  const { walletName: wallet, walletAddress } = params;
  // What the transaction is decides first: a refusal doesn't depend on the key.
  const transfer = decodeSessionTransfer(params);

  return withWalletKeys({
    wallet,
    fn: async () => {
      // Built under the lock, so a renewal that just finished is seen.
      const deps = injected ?? liveTransferDeps(wallet);
      if (!params.broadcast) {
        const check = await checkTransfer({
          wallet,
          walletAddress,
          chainId: params.chainId,
          ...transfer,
          deps
        });
        console.log(
          JSON.stringify(
            {
              ok: true,
              dryRun: true,
              mode: 'session',
              walletName: wallet,
              walletAddress,
              transactions: params.transactions,
              allowance: {
                token: check.symbol,
                amount: formatUnits(transfer.amount, check.decimals),
                usd: check.usd,
                remainingOnChain:
                  check.remaining === null ? null : formatUnits(check.remaining, check.decimals),
                allowanceUsd: check.allowanceUsd,
                spentUsd: check.spentUsd
              },
              hint: 'Dry run only, nothing was sent. Re-run with --broadcast to execute.'
            },
            bigintReplacer,
            2
          )
        );
        return { walletAddress, dryRun: true };
      }
      // Retry revoking any replaced key OMS hasn't confirmed revoked; best effort.
      await retireParkedRacs({ wallet }).catch(() => undefined);
      const result = await sessionTransfer({
        wallet,
        walletAddress,
        chainId: params.chainId,
        ...transfer,
        purpose: params.purpose ?? 'send',
        ref: params.ref,
        notAfter: params.notAfter,
        deps
      });
      return { walletAddress, txHash: result.txHash };
    }
  });
}

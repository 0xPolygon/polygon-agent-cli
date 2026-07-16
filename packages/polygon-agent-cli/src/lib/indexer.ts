// Funded check for the post-login funding step: does the wallet hold any balance
// (native or tokens) on the chain? Routes funded -> dashboard, empty -> funding.
//
// Uses the OMS SDK's own indexer (`oms.indexer.getBalances`, the same call the
// `balances` command uses), which authenticates with the wallet's session — so it
// needs no separate indexer access key and won't misreport a funded wallet as
// empty. Any error returns false so callers fall through to the funding page
// rather than erroring.

import { findNetworkById } from '@polygonlabs/oms-wallet';

import { getOmsClient } from './oms-client.ts';

function toBigInt(v: unknown): bigint {
  try {
    return BigInt((v as string | undefined) || '0');
  } catch {
    return 0n;
  }
}

/** True if the wallet holds any native or token balance on `chainId`. */
export async function isWalletFunded(
  walletName: string,
  walletAddress: string,
  chainId = 137
): Promise<boolean> {
  try {
    const network = findNetworkById(chainId);
    if (!network) return false;

    const oms = getOmsClient(walletName);
    const res = await oms.indexer.getBalances({
      walletAddress,
      networks: [network],
      includeMetadata: true
    });

    if (toBigInt(res.nativeBalances?.[0]?.balance) > 0n) return true;
    for (const b of res.balances ?? []) {
      if (toBigInt((b as { balance?: string }).balance) > 0n) return true;
    }
    return false;
  } catch {
    // Session expired / indexer error / unsupported chain: treat as empty so we
    // show funding rather than throwing.
    return false;
  }
}

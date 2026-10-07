// The live implementations behind session mode: the session-key client, the
// OMS indexer for balances, and Trails for prices.

import type { Address } from 'viem';

import type { BalancesResult } from '@polygonlabs/oms-wallet';

import { findNetworkById } from '@polygonlabs/oms-wallet';

import type { TransferDeps } from './transfer.ts';

import { CliError } from '../errors.ts';
import { getOmsClient } from '../oms-client.ts';
import { getUsdPrices, priceKey } from '../prices.ts';
import { racClient, readRacRecord } from './rac.ts';

export async function tokenBalance(params: {
  wallet: string;
  chainId: number;
  token: Address;
  walletAddress: string;
}): Promise<bigint> {
  const network = findNetworkById(params.chainId);
  if (!network) return 0n;
  const res = await getOmsClient(params.wallet).indexer.getBalances({
    walletAddress: params.walletAddress,
    networks: [network],
    contractAddresses: [params.token]
  });
  const entry = res.balances.find(
    (balance) => balance.contractAddress.toLowerCase() === params.token.toLowerCase()
  );
  return entry ? BigInt(entry.balance) : 0n;
}

// Everything the wallet holds on the given chains (one indexer call).
export async function walletHoldings(params: {
  wallet: string;
  walletAddress: string;
  chainIds: number[];
}): Promise<BalancesResult> {
  const networks = params.chainIds
    .map((chainId) => findNetworkById(chainId))
    .filter((network) => network !== undefined);
  return getOmsClient(params.wallet).indexer.getBalances({
    walletAddress: params.walletAddress,
    networks,
    includeMetadata: true
  });
}

export function liveTransferDeps(wallet: string): TransferDeps {
  const record = readRacRecord({ wallet, slot: 'rac' });
  if (!record) {
    throw new CliError({
      code: 'not_connected',
      message: `Wallet '${wallet}' has no session key on this install.`,
      command: 'polygon-agent wallet login --email <email>'
    });
  }
  return {
    credentialId: record.credentialId,
    client: racClient({ wallet, slot: 'rac' }),
    balanceOf: (params) => tokenBalance({ wallet, ...params }),
    usdPrice: async (params) => {
      const query = { chainId: params.chainId, address: params.token };
      try {
        return (await getUsdPrices([query])).get(priceKey(query));
      } catch {
        return undefined;
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date()
  };
}

// Reading chains through Sequence's node gateway with the project's access
// key: public RPCs rate-limit a busy worker (polygon.drpc.org answered 429
// mid-deposit). Without a key, viem's public default is used.

import { findNetworkById } from '@polygonlabs/oms-wallet';

export function rpcUrl(chainId: number, accessKey: string | undefined): string | undefined {
  const network = findNetworkById(chainId);
  if (!accessKey || !network) return undefined;
  return `https://nodes.sequence.app/${network.name}/${accessKey}`;
}

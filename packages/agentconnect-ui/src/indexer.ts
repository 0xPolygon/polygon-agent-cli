import { Network } from '@0xsequence/wallet-primitives';

// Chain-specific Sequence Indexer base URL pattern.
// The polygon indexer is at polygon-indexer.sequence.app; other chains follow <chain>-indexer.sequence.app
const DEFAULT_INDEXER_BASE = 'https://{chain}-indexer.sequence.app/rpc/Indexer';

function getIndexerAccessKey(): string | undefined {
  return (
    (import.meta.env.VITE_INDEXER_ACCESS_KEY as string | undefined) ||
    (import.meta.env.VITE_POLYGON_INDEXER_ACCESS_KEY as string | undefined) ||
    // Fall back to project access key — they're often the same value
    (import.meta.env.VITE_PROJECT_ACCESS_KEY as string | undefined) ||
    undefined
  );
}

/** Returns the chain slug used in the Sequence indexer hostname (e.g. "polygon", "mainnet"). */
function chainSlug(chainId: number): string {
  // Sequence indexer host uses the network name; look it up or fall back to numeric id.
  try {
    const net = Network.getNetworkFromChainId(chainId);
    if (net?.name) return net.name.toLowerCase();
  } catch {
    // ignore
  }
  return String(chainId);
}

/** Build the indexer base URL for a given chain. Respects VITE_INDEXER_URL override. */
function indexerBase(chainId: number): string {
  const override = import.meta.env.VITE_INDEXER_URL as string | undefined;
  if (override) return override.replace(/\/+$/, '');
  const slug = chainSlug(chainId);
  return DEFAULT_INDEXER_BASE.replace('{chain}', slug);
}

/** Fetch total USD portfolio value using the chain-specific Sequence Indexer. */
export async function fetchTotalUsdBalance(walletAddress: string, chainId = 137): Promise<number> {
  const accessKey = getIndexerAccessKey();
  if (!accessKey) {
    console.warn(
      '[indexer] No access key found — set VITE_INDEXER_ACCESS_KEY or VITE_PROJECT_ACCESS_KEY'
    );
    return 0;
  }

  const base = indexerBase(chainId);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Access-Key': accessKey
  };

  let total = 0;

  // 1. ERC20 token balances
  try {
    const tokenRes = await fetch(`${base}/GetTokenBalances`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        accountAddress: walletAddress,
        includeMetadata: true
      })
    });

    if (tokenRes.ok) {
      const tokenData = (await tokenRes.json()) as { balances?: { balanceUSD?: string }[] };
      for (const b of tokenData?.balances ?? []) {
        const v = parseFloat(b?.balanceUSD ?? '0');
        if (Number.isFinite(v) && v > 0) total += v;
      }
    } else {
      console.warn('[indexer] GetTokenBalances failed:', tokenRes.status);
    }
  } catch (err) {
    console.warn('[indexer] GetTokenBalances error:', err);
  }

  // 2. Native token balance
  try {
    const nativeRes = await fetch(`${base}/GetNativeTokenBalance`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        accountAddress: walletAddress
      })
    });

    if (nativeRes.ok) {
      const nativeData = (await nativeRes.json()) as { balance?: { balanceUSD?: string } };
      const v = parseFloat(nativeData?.balance?.balanceUSD ?? '0');
      if (Number.isFinite(v) && v > 0) total += v;
    } else {
      console.warn('[indexer] GetNativeTokenBalance failed:', nativeRes.status);
    }
  } catch (err) {
    console.warn('[indexer] GetNativeTokenBalance error:', err);
  }

  return total;
}

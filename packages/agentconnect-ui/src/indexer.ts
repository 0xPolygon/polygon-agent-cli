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

async function indexerCall<T>(chainId: number, method: string, body: unknown): Promise<T> {
  const accessKey = getIndexerAccessKey();
  if (!accessKey) {
    throw new Error(
      'No indexer access key: set VITE_INDEXER_ACCESS_KEY or VITE_PROJECT_ACCESS_KEY'
    );
  }
  const res = await fetch(`${indexerBase(chainId)}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Access-Key': accessKey },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`${method} failed: ${res.status}`);
  return (await res.json()) as T;
}

function num(v: unknown): number {
  const n = parseFloat(String(v ?? '0'));
  return Number.isFinite(n) ? n : 0;
}

function units(raw: string | undefined, decimals: number): number {
  if (!raw) return 0;
  try {
    const big = BigInt(raw);
    const base = 10n ** BigInt(decimals);
    return Number(big / base) + Number(big % base) / Number(base);
  } catch {
    return 0;
  }
}

// ── Holdings ──

export type HoldingKind = 'spend' | 'earn';

export interface Holding {
  symbol: string;
  name: string;
  qty: number;
  usd: number;
  kind: HoldingKind;
  // Where an earning position lives (e.g. "Aave"), for display.
  protocol?: string;
}

// Yield-bearing receipts the CLI's `deposit` produces: Aave aTokens (aPolUSDC)
// and ERC-4626 vault shares (Morpho, Euler, and similar).
export function classifyToken(
  symbol: string,
  name: string
): { kind: HoldingKind; protocol?: string } {
  if (/^aPol/i.test(symbol) || /\baave\b/i.test(name)) return { kind: 'earn', protocol: 'Aave' };
  if (/morpho/i.test(name)) return { kind: 'earn', protocol: 'Morpho' };
  if (/euler/i.test(name)) return { kind: 'earn', protocol: 'Euler' };
  if (/\bvault\b/i.test(name)) return { kind: 'earn' };
  return { kind: 'spend' };
}

interface RawTokenBalance {
  balance?: string;
  balanceUSD?: string;
  contractInfo?: { symbol?: string; name?: string; decimals?: number };
}

/** Every token the wallet holds on `chainId`, priced in USD, largest first. */
export async function fetchHoldings(walletAddress: string, chainId = 137): Promise<Holding[]> {
  const [tokens, native] = await Promise.all([
    indexerCall<{ balances?: RawTokenBalance[] }>(chainId, 'GetTokenBalances', {
      accountAddress: walletAddress,
      includeMetadata: true
    }),
    indexerCall<{ balance?: { balance?: string; balanceUSD?: string } }>(
      chainId,
      'GetNativeTokenBalance',
      { accountAddress: walletAddress }
    ).catch(() => ({ balance: undefined }))
  ]);

  const out: Holding[] = [];
  for (const b of tokens.balances ?? []) {
    const symbol = b.contractInfo?.symbol ?? '';
    const name = b.contractInfo?.name ?? symbol;
    const qty = units(b.balance, b.contractInfo?.decimals ?? 18);
    if (!symbol || qty <= 0) continue;
    out.push({ symbol, name, qty, usd: num(b.balanceUSD), ...classifyToken(symbol, name) });
  }
  const nativeQty = units(native.balance?.balance, 18);
  if (nativeQty > 0) {
    out.push({
      symbol: 'POL',
      name: 'Polygon',
      qty: nativeQty,
      usd: num(native.balance?.balanceUSD),
      kind: 'spend'
    });
  }
  return out.sort((a, b) => b.usd - a.usd);
}

/** Total USD portfolio value using the chain-specific Sequence Indexer. */
export async function fetchTotalUsdBalance(walletAddress: string, chainId = 137): Promise<number> {
  const holdings = await fetchHoldings(walletAddress, chainId);
  return holdings.reduce((sum, h) => sum + h.usd, 0);
}

// ── Activity ──

export interface ActivityItem {
  txnHash: string;
  timestamp: string;
  direction: 'in' | 'out';
  symbol: string;
  qty: number;
  usd: number;
  counterparty: string;
}

interface RawTransfer {
  transferType?: 'SEND' | 'RECEIVE' | 'UNKNOWN';
  from?: string;
  to?: string;
  amounts?: string[];
  amountsUSD?: string[];
  contractType?: string;
  contractInfo?: { symbol?: string; decimals?: number };
}

interface RawTransaction {
  txnHash: string;
  timestamp: string;
  transfers?: RawTransfer[];
}

/** Token movements in and out of the wallet, newest first. One row per transfer. */
export async function fetchActivity(
  walletAddress: string,
  chainId = 137,
  pageSize = 50
): Promise<ActivityItem[]> {
  const res = await indexerCall<{ transactions?: RawTransaction[] }>(
    chainId,
    'GetTransactionHistory',
    { filter: { accountAddress: walletAddress }, includeMetadata: true, page: { pageSize } }
  );
  const me = walletAddress.toLowerCase();
  const out: ActivityItem[] = [];
  for (const tx of res.transactions ?? []) {
    for (const t of tx.transfers ?? []) {
      const direction =
        t.transferType === 'RECEIVE' || t.to?.toLowerCase() === me
          ? 'in'
          : t.transferType === 'SEND' || t.from?.toLowerCase() === me
            ? 'out'
            : null;
      if (!direction) continue;
      const decimals = t.contractType === 'NATIVE' ? 18 : (t.contractInfo?.decimals ?? 18);
      const symbol = t.contractType === 'NATIVE' ? 'POL' : (t.contractInfo?.symbol ?? '');
      const qty = (t.amounts ?? []).reduce((s, a) => s + units(a, decimals), 0);
      const usd = (t.amountsUSD ?? []).reduce((s, a) => s + num(a), 0);
      out.push({
        txnHash: tx.txnHash,
        timestamp: tx.timestamp,
        direction,
        symbol,
        qty,
        usd,
        counterparty: (direction === 'in' ? t.from : t.to) ?? ''
      });
    }
  }
  return out;
}

/** Daily USD totals in and out for the last `days` days, oldest first. */
export function dailyFlow(
  items: ActivityItem[],
  days = 14,
  now = new Date()
): { date: Date; in: number; out: number }[] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const buckets = Array.from({ length: days }, (_, i) => ({
    date: new Date(start.getFullYear(), start.getMonth(), start.getDate() + i),
    in: 0,
    out: 0
  }));
  for (const it of items) {
    const t = new Date(it.timestamp);
    // Compare local midnights; rounding absorbs 23h/25h DST days.
    const day = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    const idx = Math.round((day.getTime() - start.getTime()) / 86_400_000);
    if (idx < 0 || idx >= days) continue;
    buckets[idx][it.direction] += it.usd;
  }
  return buckets;
}

import { z } from 'zod/v4';

import { Network } from '@0xsequence/wallet-primitives';
import { USDC_POLYGON } from '@polygonlabs/agent-shared';

import { getEnv } from './env';

// Chain-specific Sequence Indexer base URL pattern.
// The polygon indexer is at polygon-indexer.sequence.app; other chains follow <chain>-indexer.sequence.app
const DEFAULT_INDEXER_BASE = 'https://{chain}-indexer.sequence.app/rpc/Indexer';

function getIndexerAccessKey(): string | undefined {
  const env = getEnv();
  return (
    env.VITE_INDEXER_ACCESS_KEY ||
    env.VITE_POLYGON_INDEXER_ACCESS_KEY ||
    // Fall back to project access key — they're often the same value
    env.VITE_PROJECT_ACCESS_KEY ||
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
  const override = getEnv().VITE_INDEXER_URL;
  if (override) return override.replace(/\/+$/, '');
  const slug = chainSlug(chainId);
  return DEFAULT_INDEXER_BASE.replace('{chain}', slug);
}

async function indexerCall<S extends z.ZodType>(
  chainId: number,
  method: string,
  body: unknown,
  schema: S
): Promise<z.output<S>> {
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
  return schema.parse(await res.json());
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
  chainId: number;
  // Token contract; the zero address for POL.
  address: string;
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

// Loose objects naming only what is read below: a changed shape fails the parse,
// an added field doesn't.
const RawTokenBalance = z.looseObject({
  contractAddress: z.string().optional(),
  balance: z.string().optional(),
  balanceUSD: z.string().optional(),
  contractInfo: z
    .looseObject({
      symbol: z.string().optional(),
      name: z.string().optional(),
      decimals: z.number().optional()
    })
    .optional()
});
const TokenBalances = z.looseObject({ balances: z.array(RawTokenBalance).optional() });
const NativeBalance = z.looseObject({
  balance: z
    .looseObject({ balance: z.string().optional(), balanceUSD: z.string().optional() })
    .optional()
});

// Polygon stablecoins an earn receipt can be backed by, priced at $1, with
// their decimals.
const STABLES: Record<string, number> = {
  [USDC_POLYGON.toLowerCase()]: 6, // USDC
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': 6, // USDC.e
  '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': 6, // USDT0
  '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': 18 // DAI
};

const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const addressOf = (result?: string) =>
  result && result.length >= 66 ? `0x${result.slice(-40)}`.toLowerCase() : undefined;

const RpcReplies = z.array(z.looseObject({ id: z.number(), result: z.string().optional() }));

export async function rpcCalls(
  chainId: number,
  calls: { to: string; data: string }[]
): Promise<(string | undefined)[]> {
  const res = await fetch(
    `https://nodes.sequence.app/${chainSlug(chainId)}/${getIndexerAccessKey() ?? ''}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        calls.map((c, id) => ({
          jsonrpc: '2.0',
          id,
          method: 'eth_call',
          params: [{ to: c.to, data: c.data }, 'latest']
        }))
      )
    }
  );
  if (!res.ok) throw new Error(`RPC failed: ${res.status}`);
  const out = RpcReplies.parse(await res.json());
  return calls.map((_, id) => out.find((o) => o.id === id)?.result);
}

/**
 * Values earn receipts the indexer has no price for, from the chain: ERC-4626
 * vault shares (Morpho and others) through `convertToAssets`, and Aave aTokens
 * 1:1 with what they wrap. Only receipts backed by a known stablecoin are
 * priced; they are also marked as earning whatever their name says.
 */
export async function priceReceipts(
  chainId: number,
  tokens: { address: string; raw: bigint }[]
): Promise<Map<string, number>> {
  const priced = new Map<string, number>();
  if (chainId !== 137 || tokens.length === 0) return priced;
  // asset() = 0x38d52e0f, UNDERLYING_ASSET_ADDRESS() = 0xb16a19de
  const backing = await rpcCalls(
    chainId,
    tokens.flatMap((t) => [
      { to: t.address, data: '0x38d52e0f' },
      { to: t.address, data: '0xb16a19de' }
    ])
  );
  const vaults: { address: string; raw: bigint; decimals: number }[] = [];
  tokens.forEach((t, i) => {
    const asset = addressOf(backing[2 * i]);
    const underlying = addressOf(backing[2 * i + 1]);
    if (underlying && STABLES[underlying] !== undefined) {
      priced.set(t.address, Number(t.raw) / 10 ** STABLES[underlying]);
    } else if (asset && STABLES[asset] !== undefined) {
      vaults.push({ ...t, decimals: STABLES[asset] });
    }
  });
  if (vaults.length) {
    // convertToAssets(uint256) = 0x07a2d13a
    const assets = await rpcCalls(
      chainId,
      vaults.map((v) => ({ to: v.address, data: `0x07a2d13a${word(v.raw.toString(16))}` }))
    );
    vaults.forEach((v, i) => {
      const r = assets[i];
      if (r && r !== '0x') priced.set(v.address, Number(BigInt(r)) / 10 ** v.decimals);
    });
  }
  return priced;
}

/** Every token the wallet holds on `chainId`, priced in USD, largest first. */
export async function fetchHoldings(walletAddress: string, chainId = 137): Promise<Holding[]> {
  const [tokens, native] = await Promise.all([
    indexerCall(
      chainId,
      'GetTokenBalances',
      { accountAddress: walletAddress, includeMetadata: true },
      TokenBalances
    ),
    indexerCall(
      chainId,
      'GetNativeTokenBalance',
      { accountAddress: walletAddress },
      NativeBalance
    ).catch(() => ({ balance: undefined }))
  ]);

  const held = (tokens.balances ?? []).filter(
    (b) => b.contractInfo?.symbol && units(b.balance, b.contractInfo?.decimals ?? 18) > 0
  );
  const unpriced = held.filter((b) => num(b.balanceUSD) === 0 && b.contractAddress && b.balance);
  const receipts = await priceReceipts(
    chainId,
    unpriced.map((b) => ({ address: b.contractAddress!.toLowerCase(), raw: BigInt(b.balance!) }))
  ).catch(() => new Map<string, number>());

  const out: Holding[] = [];
  for (const b of held) {
    const symbol = b.contractInfo!.symbol!;
    const name = b.contractInfo?.name ?? symbol;
    const qty = units(b.balance, b.contractInfo?.decimals ?? 18);
    const receipt = receipts.get(b.contractAddress?.toLowerCase() ?? '');
    const kind = classifyToken(symbol, name);
    out.push({
      chainId,
      address: b.contractAddress?.toLowerCase() ?? '',
      symbol,
      name,
      qty,
      usd: receipt ?? num(b.balanceUSD),
      ...(receipt === undefined ? kind : { kind: 'earn' as const, protocol: kind.protocol })
    });
  }
  const nativeQty = units(native.balance?.balance, 18);
  if (nativeQty > 0) {
    out.push({
      chainId,
      address: '0x0000000000000000000000000000000000000000',
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
  address: string;
  scaleKnown: boolean;
}

const RawTransfer = z.looseObject({
  // SEND, RECEIVE or UNKNOWN; left a plain string so a new value can't fail the page.
  transferType: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  amounts: z.array(z.string()).optional(),
  amountsUSD: z.array(z.string()).optional(),
  contractType: z.string().optional(),
  contractAddress: z.string().optional(),
  contractInfo: z
    .looseObject({ symbol: z.string().optional(), decimals: z.number().optional() })
    .optional()
});
const TransactionHistory = z.looseObject({
  transactions: z
    .array(
      z.looseObject({
        txnHash: z.string(),
        timestamp: z.string(),
        transfers: z.array(RawTransfer).optional()
      })
    )
    .optional()
});

/** Token movements in and out of the wallet, newest first. One row per transfer. */
export async function fetchActivity(
  walletAddress: string,
  chainId = 137,
  pageSize = 50
): Promise<ActivityItem[]> {
  const res = await indexerCall(
    chainId,
    'GetTransactionHistory',
    { filter: { accountAddress: walletAddress }, includeMetadata: true, page: { pageSize } },
    TransactionHistory
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
        counterparty: (direction === 'in' ? t.from : t.to) ?? '',
        address: t.contractAddress?.toLowerCase() ?? '',
        scaleKnown: t.contractType === 'NATIVE' || typeof t.contractInfo?.decimals === 'number'
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

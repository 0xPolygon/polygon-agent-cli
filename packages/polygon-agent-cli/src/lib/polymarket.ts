import type { PolymarketErrorCode } from './errors.ts';

import { CliError } from './errors.ts';

// Polymarket integration library — CLOB V2
// Covers: Gamma API (market discovery), CLOB V2 API (trading via @polymarket/clob-client-v2), on-chain ops
//
// Architecture: OMS smart wallet → Polymarket proxy wallet → CLOB
// - OMS smart wallet funds the Polymarket proxy wallet (USDC.e transfer)
// - Proxy wallet wraps USDC.e → pUSD via CollateralOnramp before trading
// - EOA calls proxy.execute([approve, wrap]) to run on-chain ops FROM the proxy wallet
// - CLOB orders use maker=proxyWallet, signer=EOA, signatureType=POLY_PROXY

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWalletClient = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPublicClient = any;

export interface Market {
  id: string;
  conditionId: string;
  question: string;
  // 'v1' (CTF) or 'v2' (Polymarket V2). Decides which Gamma id field holds the token ids.
  version: string;
  yesTokenId: string | null;
  noTokenId: string | null;
  yesPrice: number | null;
  noPrice: number | null;
  outcomes: string[];
  volume24hr: number;
  negRisk: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  endDate: string | null;
}

export interface ProxyTx {
  typeCode?: number;
  to: string;
  value?: string | number | bigint;
  data: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

export const GAMMA_URL = process.env.POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com';
export const CLOB_URL = process.env.POLYMARKET_CLOB_URL || 'https://clob.polymarket.com';
export const DATA_URL = process.env.POLYMARKET_DATA_URL || 'https://data-api.polymarket.com';

// Polygon mainnet (chain 137)
export const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e — 6 decimals
export const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'; // pUSD — Polymarket USD, 6 decimals
export const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'; // Conditional Token Framework
export const CTF_EXCHANGE = '0xE111180000d2663C0091e4f400237545B87B996B'; // CLOB V2 exchange
export const NEG_RISK_CTF_EXCHANGE = '0xe2222d279d744050d28e00520010520000310F59'; // V2 neg-risk exchange
// Polymarket V2 markets: positions live in PositionManager and trade on ExchangeV3.
export const EXCHANGE_V3 = '0xe3333700cA9d93003F00f0F71f8515005F6c00Aa';
export const POSITION_MANAGER = '0x006F54F7f9A22e0000CC2AB60031000000ae9fEF';
export const COLLATERAL_ONRAMP = '0x93070a847efEf7F70739046A929D47a521F5B8ee'; // USDC.e → pUSD wrapping
export const COLLATERAL_OFFRAMP = '0x2957922Eb93258b93368531d39fAcCA3B4dC5854'; // pUSD → USDC.e unwrapping

// Polymarket proxy wallet factory (Polygon mainnet)
export const PROXY_WALLET_FACTORY = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052';

// ─── Proxy wallet helpers ────────────────────────────────────────────────────

// Compute the Polymarket proxy wallet address for a given EOA address (CREATE2, deterministic)
export async function getPolymarketProxyWalletAddress(eoaAddress: string): Promise<string> {
  const { getProxyWalletAddress } = await import('@polymarket/sdk');
  return getProxyWalletAddress(PROXY_WALLET_FACTORY, eoaAddress);
}

// Proxy wallet ABI: proxy(Transaction[]) — selector 0x34ee9791
const PROXY_EXECUTE_ABI = [
  {
    name: 'proxy',
    type: 'function',
    inputs: [
      {
        name: 'transactions',
        type: 'tuple[]',
        components: [
          { name: 'typeCode', type: 'uint8' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' }
        ]
      }
    ],
    outputs: [{ name: '', type: 'bytes[]' }]
  }
];

// Execute a batch of transactions through the Polymarket proxy wallet (EOA is owner/caller)
export async function executeViaProxyWallet(
  walletClient: AnyWalletClient,
  publicClient: AnyPublicClient,
  proxyWalletAddress: string,
  txs: ProxyTx[]
): Promise<string> {
  const { encodeFunctionData } = await import('viem');
  const transactions = txs.map((t) => ({
    typeCode: Number(t.typeCode ?? 1),
    to: t.to,
    value: BigInt(t.value || 0),
    data: t.data
  }));
  const data = encodeFunctionData({
    abi: PROXY_EXECUTE_ABI,
    functionName: 'proxy',
    args: [transactions]
  });
  const hash = await walletClient.sendTransaction({ to: PROXY_WALLET_FACTORY, data, value: 0n });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

// A CliError whose code is specific to Polymarket, so errorJson reports it
// like every other CLI failure.
export class PolymarketError extends CliError {
  constructor(code: PolymarketErrorCode, message: string) {
    super({ code, message });
    this.name = 'PolymarketError';
  }
}

// ─── Gamma API ──────────────────────────────────────────────────────────────

export interface MarketsPage {
  markets: Market[];
  // Pass back as `cursor` for the next page; null on the last page.
  nextCursor: string | null;
}

async function gammaGet(path: string, params: URLSearchParams): Promise<unknown> {
  const res = await fetch(`${GAMMA_URL}${path}?${params}`);
  if (!res.ok) throw new Error(`Gamma API error: ${res.status} ${await res.text()}`);
  return res.json();
}

// Open markets by 24h volume, or open markets matching `search`. Listing uses
// Gamma's keyset endpoint (offset paging is deprecated); search uses
// /public-search, which returns events with their markets nested.
export async function getMarkets({
  search,
  limit = 20,
  cursor
}: {
  search?: string;
  limit?: number;
  cursor?: string;
} = {}): Promise<MarketsPage> {
  if (search) {
    const params = new URLSearchParams({
      q: search,
      limit_per_type: String(Math.min(Math.max(limit, 5), 50)),
      events_status: 'active'
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await gammaGet('/public-search', params)) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const markets = ((body?.events ?? []) as any[])
      .flatMap((e) => e.markets ?? [])
      .filter((m) => m.active !== false && m.closed !== true)
      .slice(0, limit)
      .map(parseMarket);
    return { markets, nextCursor: null };
  }

  const params = new URLSearchParams({
    limit: String(limit),
    closed: 'false',
    order: 'volume24hr',
    ascending: 'false'
  });
  if (cursor) params.set('after_cursor', cursor);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (await gammaGet('/markets/keyset', params)) as any;
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    markets: ((body?.markets ?? []) as any[]).map(parseMarket),
    nextCursor: body?.next_cursor ?? null
  };
}

// Gamma hides closed markets unless asked, so a miss is retried with closed=true.
export async function getMarket(conditionId: string): Promise<Market> {
  const needle = conditionId.toLowerCase();
  for (const closed of [undefined, 'true']) {
    const params = new URLSearchParams({ condition_ids: conditionId });
    if (closed) params.set('closed', closed);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const markets = (await gammaGet('/markets', params)) as any[];
    const found = (markets ?? []).find((m) => m.conditionId?.toLowerCase() === needle);
    if (found) return parseMarket(found);
  }
  throw new Error(`Market not found: ${conditionId}`);
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// Polymarket V2 markets trade on a new exchange and identify outcomes by
// `positionIds`; V1 (CTF) markets use `clobTokenIds`. Gamma can return both
// fields, so the id field is chosen by `version`, never by presence.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseMarket(m: any): Market {
  const version: string = m.version ?? 'v1';
  const tokenIds =
    version === 'v1'
      ? parseJsonArray(m.clobTokenIds)
      : version === 'v2'
        ? parseJsonArray(m.positionIds)
        : [];
  const prices = parseJsonArray(m.outcomePrices);
  const outcomes = m.outcomes === undefined ? ['Yes', 'No'] : parseJsonArray(m.outcomes);

  return {
    id: m.id,
    conditionId: m.conditionId,
    question: m.question,
    version,
    yesTokenId: tokenIds[0] || null,
    noTokenId: tokenIds[1] || null,
    yesPrice: prices[0] ? Number(prices[0]) : null,
    noPrice: prices[1] ? Number(prices[1]) : null,
    outcomes,
    volume24hr: m.volume24hr || 0,
    negRisk: !!m.negRisk,
    closed: !!m.closed,
    acceptingOrders: m.acceptingOrders !== false,
    endDate: m.endDate || null
  };
}

// The CLI signs CLOB orders for V1 (CTF) markets only. V2 markets need the
// ExchangeV3 domain and PositionManager approvals, which aren't wired up yet.
export function assertTradable(market: Market): void {
  if (market.version !== 'v1') {
    throw new PolymarketError(
      'unsupported_market_version',
      `Market ${market.conditionId} is a Polymarket ${market.version} market, which this CLI can read but not trade yet.`
    );
  }
  if (market.closed || !market.acceptingOrders) {
    throw new PolymarketError(
      'market_not_accepting_orders',
      `Market ${market.conditionId} is not accepting orders${market.closed ? ' (closed)' : ''}.`
    );
  }
}

// ─── CLOB API — public endpoints ─────────────────────────────────────────────

export async function getClobPrice(tokenId: string, side = 'BUY'): Promise<number> {
  const res = await fetch(`${CLOB_URL}/price?token_id=${tokenId}&side=${side}`);
  if (!res.ok) throw new Error(`CLOB price error: ${res.status} ${await res.text()}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json();
  return Number(data.price);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getOrderBook(tokenId: string): Promise<any> {
  const res = await fetch(`${CLOB_URL}/book?token_id=${tokenId}`);
  if (!res.ok) throw new Error(`CLOB book error: ${res.status} ${await res.text()}`);
  return res.json();
}

// ─── CLOB V2 API — @polymarket/clob-client-v2 ──────────────────────────────

async function getClobClient(
  privateKey: string,
  proxyWalletAddress?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ client: any; creds: any; address: string }> {
  const { Wallet } = await import('ethers5');
  const { ClobClient, SignatureTypeV2 } = await import('@polymarket/clob-client-v2');
  const signer = new Wallet(privateKey);
  const chainId = 137;
  const anonClient = new ClobClient({ host: CLOB_URL, chain: chainId, signer });
  const creds = await anonClient.createOrDeriveApiKey();
  const signatureType = proxyWalletAddress ? SignatureTypeV2.POLY_PROXY : SignatureTypeV2.EOA;
  const client = new ClobClient({
    host: CLOB_URL,
    chain: chainId,
    signer,
    creds,
    signatureType,
    funderAddress: proxyWalletAddress
  });
  return { client, creds, address: await signer.getAddress() };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getOpenOrders(privateKey: string): Promise<any> {
  const { client } = await getClobClient(privateKey);
  return client.getOpenOrders();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function cancelOrder(orderId: string, privateKey: string): Promise<any> {
  const { client } = await getClobClient(privateKey);
  return client.cancelOrder({ orderID: orderId });
}

// ─── CLOB V2 API — order creation ───────────────────────────────────────────

export async function createAndPostOrder({
  tokenId,
  side,
  size,
  price,
  orderType = 'GTC',
  privateKey,
  proxyWalletAddress
}: {
  tokenId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  orderType?: string;
  privateKey: string;
  proxyWalletAddress?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): Promise<any> {
  const { client } = await getClobClient(privateKey, proxyWalletAddress);
  // V2: client auto-fetches tickSize and negRisk from getClobMarketInfo
  const order = await client.createOrder({
    tokenID: tokenId,
    price,
    size,
    side
  });
  return client.postOrder(order, orderType);
}

export async function createAndPostMarketOrder({
  tokenId,
  side,
  amount,
  orderType = 'FOK',
  privateKey,
  proxyWalletAddress
}: {
  tokenId: string;
  side: 'BUY' | 'SELL';
  amount: number;
  orderType?: string;
  privateKey: string;
  proxyWalletAddress?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): Promise<any> {
  const { client } = await getClobClient(privateKey, proxyWalletAddress);
  // V2: no feeRateBps — fees determined by protocol at match time
  const order = await client.createMarketOrder({
    tokenID: tokenId,
    side,
    amount,
    orderType
  });
  return client.postOrder(order, orderType);
}

// ─── Data API v2 — positions ─────────────────────────────────────────────────

export type PositionStatus = 'OPEN' | 'REDEEMABLE' | 'REDEEMABLE_LOST' | 'MERGEABLE' | 'CLOSED';
export const POSITION_STATUSES: PositionStatus[] = [
  'OPEN',
  'REDEEMABLE',
  'REDEEMABLE_LOST',
  'MERGEABLE',
  'CLOSED'
];

export interface PositionsPage {
  // Rows as the Data API returns them (snake_case: current_size, avg_price, ...).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  positions: any[];
  nextCursor: string | null;
}

// Data API v2 (v1 retires 2026-10-24): responses are wrapped in `{ data,
// pagination }` and paged by opaque cursor. Status defaults to OPEN on the
// server, which includes settled winners not yet redeemed.
export async function getPositions(
  address: string,
  { limit = 20, status, cursor }: { limit?: number; status?: PositionStatus; cursor?: string } = {}
): Promise<PositionsPage> {
  const params = new URLSearchParams({ user: address, limit: String(limit) });
  if (status) params.set('status', status);
  if (cursor) params.set('cursor', cursor);
  const res = await fetch(`${DATA_URL}/v2/positions?${params}`);
  if (!res.ok) throw new Error(`Data API error: ${res.status} ${await res.text()}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (await res.json()) as any;
  return {
    positions: Array.isArray(body?.data) ? body.data : [],
    nextCursor: body?.pagination?.next_cursor ?? null
  };
}

// ─── Helper: fetch with Cloudflare retry ─────────────────────────────────────

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  retries = 5
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, init);
      if ((res.status === 403 || res.status === 503) && i < retries - 1) {
        const text = await res.text();
        if (text.includes('Cloudflare') || text.includes('cf-ray')) {
          await sleep(1000 * (i + 1));
          continue;
        }
        return new Response(text, { status: res.status, headers: res.headers });
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (i < retries - 1) await sleep(500 * (i + 1));
    }
  }
  throw lastErr || new Error('fetch failed after retries');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

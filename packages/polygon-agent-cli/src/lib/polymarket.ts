// Polymarket integration library — CLOB V2
// Covers: Gamma API (market discovery), CLOB V2 API (trading via @polymarket/clob-client-v2), on-chain ops
//
// Architecture: Sequence smart wallet → Polymarket proxy wallet → CLOB
// - Sequence smart wallet funds the Polymarket proxy wallet (USDC.e transfer)
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
  yesTokenId: string | null;
  noTokenId: string | null;
  yesPrice: number | null;
  noPrice: number | null;
  outcomes: string[];
  volume24hr: number;
  negRisk: boolean;
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
export const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
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

// ─── Gamma API ──────────────────────────────────────────────────────────────

export async function getMarkets({
  search,
  limit = 20,
  offset = 0
}: {
  search?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<Market[]> {
  const fetchLimit = search ? Math.max(100, limit * 5) : limit;
  const params = new URLSearchParams({
    limit: String(fetchLimit),
    offset: String(offset),
    active: 'true',
    closed: 'false',
    order: 'volume24hr',
    ascending: 'false'
  });

  const res = await fetch(`${GAMMA_URL}/markets?${params}`);
  if (!res.ok) throw new Error(`Gamma API error: ${res.status} ${await res.text()}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let markets: any[] = (await res.json()) as any[];

  if (search) {
    const q = search.toLowerCase();
    markets = markets.filter((m) => (m.question || '').toLowerCase().includes(q));
    markets = markets.slice(0, limit);
  }

  return markets.map(parseMarket);
}

export async function getMarket(conditionId: string): Promise<Market> {
  const needle = conditionId.toLowerCase();
  for (let offset = 0; offset < 500; offset += 100) {
    const params = new URLSearchParams({
      limit: '100',
      offset: String(offset),
      active: 'true',
      closed: 'false',
      order: 'volume24hr',
      ascending: 'false'
    });
    const res = await fetch(`${GAMMA_URL}/markets?${params}`);
    if (!res.ok) throw new Error(`Gamma API error: ${res.status} ${await res.text()}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const markets: any[] = (await res.json()) as any[];
    if (!markets?.length) break;
    const found = markets.find((m) => m.conditionId?.toLowerCase() === needle);
    if (found) return parseMarket(found);
  }
  const resClosed = await fetch(
    `${GAMMA_URL}/markets?conditionId=${encodeURIComponent(conditionId)}&limit=100`
  );
  if (resClosed.ok) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const closed: any[] = (await resClosed.json()) as any[];
    const found = (closed || []).find((m) => m.conditionId?.toLowerCase() === needle);
    if (found) return parseMarket(found);
  }
  throw new Error(`Market not found: ${conditionId}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseMarket(m: any): Market {
  let tokenIds: string[] = [];
  let prices: string[] = [];
  let outcomes: string[] = [];
  try {
    tokenIds = JSON.parse(m.clobTokenIds || '[]');
  } catch {
    /* ignore */
  }
  try {
    prices = JSON.parse(m.outcomePrices || '[]');
  } catch {
    /* ignore */
  }
  try {
    outcomes = JSON.parse(m.outcomes || '["Yes","No"]');
  } catch {
    /* ignore */
  }

  return {
    id: m.id,
    conditionId: m.conditionId,
    question: m.question,
    yesTokenId: tokenIds[0] || null,
    noTokenId: tokenIds[1] || null,
    yesPrice: prices[0] ? Number(prices[0]) : null,
    noPrice: prices[1] ? Number(prices[1]) : null,
    outcomes,
    volume24hr: m.volume24hr || 0,
    negRisk: !!m.negRisk,
    endDate: m.endDate || null
  };
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
  const anonClient = new ClobClient({ host: CLOB_URL, chain: 137, signer });
  const creds = await anonClient.createOrDeriveApiKey();
  const signatureType = proxyWalletAddress ? SignatureTypeV2.POLY_PROXY : SignatureTypeV2.EOA;
  const client = new ClobClient({
    host: CLOB_URL,
    chain: 137,
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

// ─── Data API — positions ────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getPositions(address: string, limit = 20): Promise<any> {
  const res = await fetch(`${DATA_URL}/positions?user=${address}&limit=${limit}`);
  if (!res.ok) throw new Error(`Data API error: ${res.status} ${await res.text()}`);
  return res.json();
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

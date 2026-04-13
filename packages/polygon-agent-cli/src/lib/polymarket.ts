// Polymarket integration library
// Covers: Gamma API (market discovery), CLOB API (trading via @polymarket/clob-client), on-chain ops
//
// Architecture: Sequence smart wallet → CLOB directly (EIP-1271 / POLY_GNOSIS_SAFE)
// - Sequence smart wallet holds USDC.e and outcome tokens directly
// - Smart wallet signs CLOB orders via session key (EIP-1271 compatible)
// - No separate EOA or proxy wallet required

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWalletClient = any;

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

// ─── Constants ──────────────────────────────────────────────────────────────

export const GAMMA_URL = process.env.POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com';
export const CLOB_URL = process.env.POLYMARKET_CLOB_URL || 'https://clob.polymarket.com';
export const DATA_URL = process.env.POLYMARKET_DATA_URL || 'https://data-api.polymarket.com';

// Polygon mainnet (chain 137)
export const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e — 6 decimals
export const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'; // Conditional Token Framework
export const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'; // CLOB exchange
export const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
export const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

// ─── Sequence session signer ─────────────────────────────────────────────────

// Build a viem WalletClient that signs with the Sequence explicit session key
// but presents the smart wallet address as the account. The Sequence smart wallet's
// isValidSignature() on-chain validates session key ECDSA signatures.
export async function buildSequenceSignerForPolymarket(
  walletName: string
): Promise<{ walletClient: AnyWalletClient; smartWalletAddress: string }> {
  const { loadWalletSession } = await import('./storage.ts');
  const { jsonRevivers } = await import('@0xsequence/dapp-client');
  const { privateKeyToAccount } = await import('viem/accounts');
  const { createWalletClient, http } = await import('viem');
  const { polygon } = await import('viem/chains');

  const session = await loadWalletSession(walletName);
  if (!session) throw new Error(`Wallet not found: ${walletName}`);

  const explicitRaw = session.explicitSession;
  if (!explicitRaw)
    throw new Error('No explicit session found. Run: polygon-agent wallet start-session');

  const explicitSession = JSON.parse(explicitRaw, jsonRevivers);
  if (!explicitSession?.pk) throw new Error('Session missing signing key. Re-link wallet.');

  const smartWalletAddress = session.walletAddress as `0x${string}`;
  const sessionAccount = privateKeyToAccount(explicitSession.pk as `0x${string}`);

  // Override address to be the smart wallet — it is the CLOB order maker.
  // The session key signs; the Sequence contract validates via isValidSignature().
  const account = { ...sessionAccount, address: smartWalletAddress };
  const walletClient = createWalletClient({ account, chain: polygon, transport: http() });

  return { walletClient, smartWalletAddress };
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

// ─── CLOB API — @polymarket/clob-client ─────────────────────────────────────

// Build a CLOB client using the Sequence smart wallet as signer (POLY_GNOSIS_SAFE).
// The smart wallet address is both the order maker and the funder address.
async function getClobClient(
  walletClient: AnyWalletClient,
  smartWalletAddress: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ client: any; creds: any }> {
  const { ClobClient } = await import('@polymarket/clob-client');
  const { SignatureType } = await import('@polymarket/order-utils');
  const chainId = 137;

  // Derive API credentials using the smart wallet signer.
  // createOrDeriveApiKey returns undefined (does not throw) if CLOB rejects the request —
  // typically because the wallet has not accepted Polymarket's Terms of Service.
  const anonClient = new ClobClient(CLOB_URL, chainId, walletClient);
  const creds = await anonClient.createOrDeriveApiKey();
  if (!creds?.key) {
    throw new Error(
      `Polymarket CLOB auth failed for wallet ${smartWalletAddress}. ` +
        'The smart wallet must accept Polymarket Terms of Service at polymarket.com before trading.'
    );
  }

  const client = new ClobClient(
    CLOB_URL,
    chainId,
    walletClient,
    creds,
    SignatureType.POLY_GNOSIS_SAFE,
    smartWalletAddress // funderAddress — the smart wallet holds and funds orders
  );

  return { client, creds };
}

export async function getOpenOrders(
  walletClient: AnyWalletClient,
  smartWalletAddress: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const { client } = await getClobClient(walletClient, smartWalletAddress);
  return client.getOpenOrders();
}

export async function cancelOrder(
  orderId: string,
  walletClient: AnyWalletClient,
  smartWalletAddress: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const { client } = await getClobClient(walletClient, smartWalletAddress);
  return client.cancelOrder({ orderID: orderId });
}

// ─── CLOB API — order creation ───────────────────────────────────────────────

export async function createAndPostOrder({
  tokenId,
  side,
  size,
  price,
  orderType = 'GTC',
  walletClient,
  smartWalletAddress
}: {
  tokenId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  orderType?: string;
  walletClient: AnyWalletClient;
  smartWalletAddress: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): Promise<any> {
  const { client } = await getClobClient(walletClient, smartWalletAddress);
  const order = await client.createOrder({
    tokenID: tokenId,
    price,
    size,
    side,
    feeRateBps: '0'
  });
  return client.postOrder(order, orderType);
}

export async function createAndPostMarketOrder({
  tokenId,
  side,
  amount,
  orderType = 'FOK',
  walletClient,
  smartWalletAddress
}: {
  tokenId: string;
  side: 'BUY' | 'SELL';
  amount: number;
  orderType?: string;
  walletClient: AnyWalletClient;
  smartWalletAddress: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): Promise<any> {
  const { client } = await getClobClient(walletClient, smartWalletAddress);
  const order = await client.createMarketOrder({
    tokenID: tokenId,
    side,
    amount,
    orderType,
    feeRateBps: '0'
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

// Quoting a swap (shared by the `swap` command and watches): resolve the
// tokens, the source and the amount, ask Trails, check the deposit, and save
// the trade as `quoted`.
//
// In session mode only covered tokens trade: the source must be a covered
// ERC-20 and the destination a covered token (buys of ETH, POL or BTC deliver
// the chain's covered WETH, WPOL or WBTC/cbBTC). Owner mode resolves any token.

import { getAddress } from 'viem';

import type { TradeRecord } from './state.ts';

import { ensureBuilderAccess } from '../builder-provision.ts';
import { readConfig } from '../config.ts';
import { CliError } from '../errors.ts';
import { getUsdPrices, priceKey, trailsClient } from '../prices.ts';
import { tokenBalance, walletHoldings } from '../session/live.ts';
import { racClient } from '../session/rac.ts';
import { withWalletKeys } from '../session/renewal.ts';
import { getSessions, sessionForToken } from '../session/sessions.ts';
import { readApprovedPlan } from '../session/state.ts';
import {
  chainLabel,
  findSupportedToken,
  resolveSupportedSymbol,
  supportedChainIds,
  supportedTokens
} from '../session/tokens.ts';
import { loadOmsWalletPointer } from '../storage.ts';
import { getTokenConfig } from '../tokens.ts';
import { formatUnits, parseUnits, resolveNetwork } from '../utils.ts';
import { saveTrade } from './state.ts';
import { validateDeposit } from './validate.ts';

export const DEFAULT_SLIPPAGE = 0.005;
const DEFAULT_MAX_SLIPPAGE = 0.01;
// A quote is executed within this long, even if Trails would allow longer.
const QUOTE_LIFETIME_MS = 5 * 60 * 1000;
// Fees above this share of the input add a warning.
const HIGH_FEE_SHARE = 0.1;

interface ResolvedToken {
  chainId: number;
  address: string;
  symbol: string;
  decimals: number;
}

export interface QuoteSwapParams {
  walletName: string;
  // Source token symbol; without it, a covered stablecoin with enough balance.
  from?: string;
  to: string;
  // Source units, `<n>%` of the balance, or `all`. Exactly one of amount/amountUsd.
  amount?: string;
  amountUsd?: number;
  chain?: string;
  toChain?: string;
  slippage?: number;
  now: Date;
}

export interface QuotedSwap {
  trade: TradeRecord;
  warnings: string[];
}

function maxSlippage(): number {
  const value = readConfig().max_slippage;
  return typeof value === 'number' && value > 0 && value < 0.5 ? value : DEFAULT_MAX_SLIPPAGE;
}

function covered(params: { wallet: string; chainId: number; token: string }): boolean {
  const plan = readApprovedPlan(params.wallet)?.plan;
  return (
    plan?.chains
      .find((chain) => chain.chainId === params.chainId)
      ?.grants.some((grant) => grant.token.toLowerCase() === params.token.toLowerCase()) ?? false
  );
}

function notCovered(params: { symbol: string; chainId: number }): CliError {
  const chain = resolveNetwork(params.chainId).name;
  return new CliError({
    code: 'not_covered',
    message: `${params.symbol} on ${chainLabel(params.chainId)} isn't covered by the allowance.`,
    command: `polygon-agent wallet allowance set --add ${params.symbol}@${chain}`
  });
}

function isNativeSymbol(params: { chainId: number; symbol: string }): boolean {
  const symbol = params.symbol.toUpperCase();
  const native = resolveNetwork(params.chainId).nativeToken?.symbol?.toUpperCase();
  return symbol === 'NATIVE' || symbol === native;
}

// Session mode: the source must be a covered ERC-20 (no aliases: selling "ETH"
// means the native coin, which sessions can't move).
function sessionSource(params: { wallet: string; chainId: number; symbol: string }): ResolvedToken {
  const symbol = params.symbol.toUpperCase();
  const token = supportedTokens(params.chainId).find((t) => t.symbol.toUpperCase() === symbol);
  if (!token) {
    if (isNativeSymbol(params)) {
      throw new CliError({
        code: 'native_not_supported',
        message: `${symbol} is the native coin on ${chainLabel(params.chainId)}, which this install's allowance can't spend.`,
        hint: 'Sell a covered token instead, or ask the owner.'
      });
    }
    throw notCovered({ symbol, chainId: params.chainId });
  }
  if (!covered({ wallet: params.wallet, chainId: params.chainId, token: token.address })) {
    throw notCovered({ symbol: token.symbol, chainId: params.chainId });
  }
  return { chainId: params.chainId, ...token };
}

// Session mode: buys deliver a covered token (ETH → WETH, POL → WPOL, …).
function sessionDestination(params: {
  wallet: string;
  chainId: number;
  symbol: string;
}): ResolvedToken {
  const token = resolveSupportedSymbol(params);
  if (
    !token ||
    !covered({ wallet: params.wallet, chainId: params.chainId, token: token.address })
  ) {
    throw notCovered({
      symbol: token?.symbol ?? params.symbol.toUpperCase(),
      chainId: params.chainId
    });
  }
  return { chainId: params.chainId, ...token };
}

async function ownerToken(params: { chainId: number; symbol: string }): Promise<ResolvedToken> {
  const network = resolveNetwork(params.chainId);
  const token = await getTokenConfig({
    chainId: params.chainId,
    symbol: params.symbol,
    nativeSymbol: network.nativeToken?.symbol || 'NATIVE'
  });
  return { chainId: params.chainId, ...token };
}

function invalidAmount(value: string): CliError {
  return new CliError({
    code: 'invalid_input',
    message: `Not an amount: "${value}". Use a number, <n>%, or all.`
  });
}

// "all" / "<n>%" as a share in basis points, or null for a plain amount.
function shareBps(amount: string): bigint | null {
  const value = amount.trim().toLowerCase();
  if (value === 'all') return 10_000n;
  if (!value.endsWith('%')) return null;
  const pct = Number(value.slice(0, -1));
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw invalidAmount(amount);
  return BigInt(Math.floor(pct * 100));
}

async function usdPrice(token: ResolvedToken): Promise<number> {
  if (findSupportedToken({ chainId: token.chainId, address: token.address })?.kind === 'usd') {
    return 1;
  }
  const query = { chainId: token.chainId, address: token.address };
  const price = (await getUsdPrices([query]).catch(() => new Map<string, number>())).get(
    priceKey(query)
  );
  if (price === undefined) {
    throw new CliError({
      code: 'upstream_unavailable',
      message: `No current USD price for ${token.symbol}, so --amount-usd can't be converted. Try again shortly, or give --amount.`
    });
  }
  return price;
}

// USD → token units, rounded down (integer math: micro-dollars over a price
// scaled by 1e12).
function unitsForUsd(params: { usd: number; priceUsd: number; decimals: number }): bigint {
  const micros = BigInt(Math.floor(params.usd * 1e6));
  const price = BigInt(Math.round(params.priceUsd * 1e12));
  if (price <= 0n)
    throw new CliError({ code: 'upstream_unavailable', message: 'No usable price.' });
  return (micros * 10n ** BigInt(params.decimals) * 1_000_000n) / price;
}

// The source token's amount in its units.
async function sourceAmount(params: {
  walletName: string;
  walletAddress: string;
  token: ResolvedToken;
  amount?: string;
  amountUsd?: number;
}): Promise<bigint> {
  const { token } = params;
  if (params.amountUsd !== undefined) {
    if (!Number.isFinite(params.amountUsd) || params.amountUsd <= 0) {
      throw new CliError({ code: 'invalid_input', message: '--amount-usd must be positive.' });
    }
    return unitsForUsd({
      usd: params.amountUsd,
      priceUsd: await usdPrice(token),
      decimals: token.decimals
    });
  }
  const amount = params.amount ?? '';
  const bps = shareBps(amount);
  if (bps !== null && token.address === '0x0000000000000000000000000000000000000000') {
    throw new CliError({
      code: 'invalid_input',
      message: `Give an amount of ${token.symbol}; <n>% and all work for tokens, not the native coin.`
    });
  }
  if (bps !== null) {
    const balance = await tokenBalance({
      wallet: params.walletName,
      chainId: token.chainId,
      token: getAddress(token.address),
      walletAddress: params.walletAddress
    });
    return (balance * bps) / 10_000n;
  }
  if (!/^\d+(\.\d+)?$/.test(amount.trim())) throw invalidAmount(amount);
  return parseUnits(amount.trim(), token.decimals);
}

// Without --from: the first covered stablecoin with enough balance (and, in
// session mode, on-chain allowance left): USDC on Polygon, USDC on other
// chains, then other stablecoins. With --chain, only that chain.
async function defaultSource(params: {
  walletName: string;
  walletAddress: string;
  session: boolean;
  chainId?: number;
  amount?: string;
  amountUsd?: number;
}): Promise<{ token: ResolvedToken; amount: bigint }> {
  const chainIds = params.chainId !== undefined ? [params.chainId] : supportedChainIds();
  const candidates = chainIds
    .flatMap((chainId) =>
      supportedTokens(chainId)
        .filter((token) => token.kind === 'usd')
        .map((token) => ({ chainId, ...token }))
    )
    .filter(
      (token) =>
        !params.session ||
        covered({ wallet: params.walletName, chainId: token.chainId, token: token.address })
    );
  const rank = (token: ResolvedToken) =>
    (token.symbol === 'USDC' ? 0 : 2) + (token.chainId === 137 ? 0 : 1);
  candidates.sort((a, b) => rank(a) - rank(b));
  if (candidates.length === 0) {
    throw new CliError({
      code: 'not_covered',
      message: 'No covered stablecoin to pay with. Name the token to sell with --from.'
    });
  }

  const holdings = await walletHoldings({
    wallet: params.walletName,
    walletAddress: params.walletAddress,
    chainIds: [...new Set(candidates.map((token) => token.chainId))]
  });
  const balanceOf = (token: ResolvedToken) =>
    BigInt(
      holdings.balances.find(
        (b) =>
          b.chainId === token.chainId &&
          b.contractAddress.toLowerCase() === token.address.toLowerCase()
      )?.balance || '0'
    );
  const sessions = params.session
    ? await withWalletKeys({
        wallet: params.walletName,
        fn: () =>
          getSessions({
            wallet: params.walletName,
            client: racClient({ wallet: params.walletName, slot: 'rac' }),
            fresh: true
          })
      })
    : [];

  for (const token of candidates) {
    const balance = balanceOf(token);
    if (balance === 0n) continue;
    const bps = params.amount !== undefined ? shareBps(params.amount) : null;
    let amount: bigint;
    if (params.amountUsd !== undefined) {
      amount = unitsForUsd({ usd: params.amountUsd, priceUsd: 1, decimals: token.decimals });
    } else if (bps !== null) {
      amount = (balance * bps) / 10_000n;
    } else {
      if (!/^\d+(\.\d+)?$/.test((params.amount ?? '').trim()))
        throw invalidAmount(params.amount ?? '');
      amount = parseUnits((params.amount ?? '').trim(), token.decimals);
    }
    if (amount === 0n || amount > balance) continue;
    if (params.session) {
      // Needs a live session for it (planned isn't enough), with room left.
      const live = sessionForToken({ sessions, chainId: token.chainId, token: token.address });
      if (!live) continue;
      if (live.grant.remaining !== null && amount > live.grant.remaining) continue;
    }
    return { token, amount };
  }
  throw new CliError({
    code: 'insufficient_balance',
    message: `No covered stablecoin${params.chainId !== undefined ? ` on ${chainLabel(params.chainId)}` : ''} holds enough for this trade${params.session ? ' within the allowance' : ''}.`,
    hint: 'Name the token to sell with --from, or use a smaller amount.'
  });
}

export async function quoteSwap(params: QuoteSwapParams): Promise<QuotedSwap> {
  const pointer = await loadOmsWalletPointer(params.walletName);
  if (!pointer) {
    throw new CliError({
      code: 'not_connected',
      message: `Wallet '${params.walletName}' isn't connected.`,
      command: 'polygon-agent wallet login --email <email>'
    });
  }
  const session = pointer.access === 'session';
  const walletAddress = pointer.walletAddress;

  if ((params.amount === undefined) === (params.amountUsd === undefined)) {
    throw new CliError({
      code: 'invalid_input',
      message: 'Give exactly one of --amount or --amount-usd.'
    });
  }
  const slippage = params.slippage ?? DEFAULT_SLIPPAGE;
  const max = maxSlippage();
  if (!Number.isFinite(slippage) || slippage <= 0 || slippage > max) {
    throw new CliError({
      code: 'invalid_input',
      message: `Slippage must be above 0 and at most ${max} (max_slippage in config.json).`
    });
  }

  const chainId = params.chain ? resolveNetwork(params.chain).chainId : undefined;
  let origin: ResolvedToken;
  let amount: bigint;
  if (params.from) {
    const originChainId = chainId ?? 137;
    origin = session
      ? sessionSource({ wallet: params.walletName, chainId: originChainId, symbol: params.from })
      : await ownerToken({ chainId: originChainId, symbol: params.from });
    amount = await sourceAmount({
      walletName: params.walletName,
      walletAddress,
      token: origin,
      amount: params.amount,
      amountUsd: params.amountUsd
    });
  } else {
    ({ token: origin, amount } = await defaultSource({
      walletName: params.walletName,
      walletAddress,
      session,
      chainId,
      amount: params.amount,
      amountUsd: params.amountUsd
    }));
  }
  if (amount <= 0n) {
    throw new CliError({
      code: 'insufficient_balance',
      message: `Nothing to trade: the amount of ${origin.symbol} comes to 0.`
    });
  }

  const destinationChainId = params.toChain
    ? resolveNetwork(params.toChain).chainId
    : origin.chainId;
  const destination = session
    ? sessionDestination({
        wallet: params.walletName,
        chainId: destinationChainId,
        symbol: params.to
      })
    : await ownerToken({ chainId: destinationChainId, symbol: params.to });
  if (
    destination.chainId === origin.chainId &&
    destination.address.toLowerCase() === origin.address.toLowerCase()
  ) {
    throw new CliError({
      code: 'invalid_input',
      message: 'The source and destination are the same token on the same chain.'
    });
  }

  if (!process.env.TRAILS_API_KEY && !process.env.SEQUENCE_PROJECT_ACCESS_KEY) {
    await ensureBuilderAccess(walletAddress);
  }
  const { TradeType } = await import('@0xtrails/api');
  const trails = await trailsClient();
  const { intent } = await trails.quoteIntent({
    ownerAddress: walletAddress,
    originChainId: origin.chainId,
    originTokenAddress: origin.address,
    originTokenAmount: amount,
    destinationChainId: destination.chainId,
    destinationTokenAddress: destination.address,
    destinationToAddress: walletAddress,
    tradeType: TradeType.EXACT_INPUT,
    options: { slippageTolerance: slippage }
  });
  validateDeposit({
    intent,
    walletAddress,
    originChainId: origin.chainId,
    originToken: origin.address,
    destinationChainId: destination.chainId,
    destinationToken: destination.address,
    amount,
    slippage
  });

  const warnings: string[] = [];
  const fromUsd = intent.quote?.fromAmountUsd ?? 0;
  const feeUsd = intent.fees?.totalFeeUsd ?? 0;
  if (fromUsd > 0 && feeUsd / fromUsd > HIGH_FEE_SHARE) {
    warnings.push(
      `Fees are $${feeUsd.toFixed(2)}, ${Math.round((feeUsd / fromUsd) * 100)}% of the $${fromUsd.toFixed(2)} being traded.`
    );
  }

  const now = params.now;
  const intentExpiry = Date.parse(intent.expiresAt);
  const expiresAt = new Date(
    Math.min(
      Number.isFinite(intentExpiry) ? intentExpiry : Infinity,
      now.getTime() + QUOTE_LIFETIME_MS
    )
  );
  const deposit = intent.depositTransaction;
  const trade: TradeRecord = {
    intentId: intent.intentId,
    walletName: params.walletName,
    walletAddress,
    mode: session ? 'session' : 'owner',
    state: 'quoted',
    origin: {
      chainId: origin.chainId,
      chain: chainLabel(origin.chainId),
      token: origin.address,
      symbol: origin.symbol,
      decimals: origin.decimals,
      amount: amount.toString()
    },
    destination: {
      chainId: destination.chainId,
      chain: chainLabel(destination.chainId),
      token: destination.address,
      symbol: destination.symbol,
      decimals: destination.decimals,
      expectedAmount: String(intent.quote?.toAmount ?? 0n),
      minAmount: String(intent.quote?.toAmountMin ?? 0n)
    },
    quote: {
      fromAmountUsd: fromUsd,
      toAmountUsd: intent.quote?.toAmountUsd ?? 0,
      totalFeeUsd: feeUsd,
      priceImpact: intent.quote?.priceImpact ?? 0,
      slippage,
      routeProviders: (intent.quote?.routeProviders ?? []).map(String),
      intentExpiresAt: intent.expiresAt
    },
    expiresAt: expiresAt.toISOString(),
    deposit: { to: deposit.to, data: deposit.data || '0x', value: String(deposit.value ?? 0n) },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
  saveTrade(trade);
  return { trade, warnings };
}

// How a trade reads to a person: amounts in token units.
export function describeTrade(trade: TradeRecord): Record<string, unknown> {
  const { origin, destination } = trade;
  return {
    intentId: trade.intentId,
    state: trade.state,
    mode: trade.mode,
    sell: {
      amount: formatUnits(origin.amount, origin.decimals),
      token: origin.symbol,
      chain: origin.chain,
      usd: trade.quote.fromAmountUsd
    },
    buy: {
      expected: formatUnits(destination.expectedAmount, destination.decimals),
      minimum: formatUnits(destination.minAmount, destination.decimals),
      token: destination.symbol,
      chain: destination.chain,
      usd: trade.quote.toAmountUsd
    },
    crossChain: origin.chainId !== destination.chainId,
    feesUsd: trade.quote.totalFeeUsd,
    priceImpact: trade.quote.priceImpact,
    slippage: trade.quote.slippage,
    route: trade.quote.routeProviders,
    quoteExpiresAt: trade.expiresAt,
    ...(trade.depositTxHash ? { depositTxHash: trade.depositTxHash } : {}),
    ...(trade.intentStatus ? { intentStatus: trade.intentStatus } : {}),
    ...(trade.receivedAmount
      ? { received: formatUnits(trade.receivedAmount, destination.decimals) }
      : {}),
    ...(trade.destinationTxHash ? { destinationTxHash: trade.destinationTxHash } : {}),
    ...(trade.refundTxHash ? { refundTxHash: trade.refundTxHash } : {}),
    ...(trade.error ? { error: trade.error } : {})
  };
}

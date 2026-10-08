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
// A quote losing more than this share of its input (fees, or fees and price
// impact) warns, is never executed by an auto trade, and is refused when quoted
// and broadcast in one step.
const HIGH_FEE_SHARE = 0.1;
// Sources an exact-output buy may quote before giving up: each one whose
// estimate fits is tried in order until a quote's cost fits too.
const MAX_QUOTES = 3;
const NATIVE = '0x0000000000000000000000000000000000000000';

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
  // Exactly one amount: source units, `<n>%` of the balance or `all`
  // (amount); USD of the source (amountUsd); or units of `to` to receive
  // (toAmount, an exact-output buy).
  amount?: string;
  amountUsd?: number;
  toAmount?: string;
  chain?: string;
  toChain?: string;
  slippage?: number;
  // Without `from`, an amount in USD may be paid from another covered holding
  // when no stablecoin holds enough (the swap command; never auto trades).
  payWithHoldings?: boolean;
  now: Date;
}

export interface QuotedSwap {
  trade: TradeRecord;
  warnings: string[];
  // Fees over 10% of the input (one of the warnings).
  highFee: boolean;
  // Paid with a holding that isn't a stablecoin, unasked (one of the warnings).
  paidWithHolding: boolean;
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

export function isNativeSymbol(params: { chainId: number; symbol: string }): boolean {
  const symbol = params.symbol.toUpperCase();
  const native = resolveNetwork(params.chainId).nativeToken?.symbol?.toUpperCase();
  // MATIC is POL's old name, and only the native coin where POL is.
  return symbol === 'NATIVE' || symbol === native || (symbol === 'MATIC' && native === 'POL');
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

// The command covering a token with no chain named: on Polygon if the table
// has it there, else the first chain that does.
function addCommand(symbol: string): string {
  const chainId =
    [137, ...supportedChainIds()].find((candidate) =>
      resolveSupportedSymbol({ chainId: candidate, symbol })
    ) ?? 137;
  return `polygon-agent wallet allowance set --add ${symbol.toUpperCase()}@${resolveNetwork(chainId).name}`;
}

// Trails' transient failures as retryable CLI errors (a watch retries them);
// anything else as it came.
async function trailsError(error: unknown): Promise<unknown> {
  const {
    QuotaRateLimitError,
    RateLimitedError,
    TimeoutError,
    UnavailableError,
    WebrpcBadResponseError,
    WebrpcRequestFailedError
  } = await import('@0xtrails/api');
  const message = error instanceof Error ? error.message : String(error);
  // A gateway's HTML 429 or 5xx page arrives as a bad response.
  const badResponse = error instanceof WebrpcBadResponseError ? error.status : 0;
  if (
    error instanceof RateLimitedError ||
    error instanceof QuotaRateLimitError ||
    badResponse === 429
  ) {
    return new CliError({
      code: 'rate_limited',
      message: `Trails is rate-limiting quotes: ${message}`,
      cause: error
    });
  }
  if (
    error instanceof UnavailableError ||
    error instanceof TimeoutError ||
    error instanceof WebrpcRequestFailedError ||
    badResponse >= 500
  ) {
    return new CliError({
      code: 'upstream_unavailable',
      message: `Trails couldn't quote right now: ${message}`,
      cause: error
    });
  }
  return error;
}

function destinationCovered(params: { wallet: string; chainId: number; symbol: string }): boolean {
  try {
    sessionDestination(params);
    return true;
  } catch {
    return false;
  }
}

// Session mode: whether a watch's auto trade could run (FS §8.2). A buy needs
// the token covered on its chain (or, without one, on some approved chain); a
// sell needs it covered as a source on its chain (Polygon by default).
export function assertTradeCovered(params: {
  walletName: string;
  side: 'buy' | 'sell';
  symbol: string;
  chainId?: number;
}): void {
  if (params.side === 'sell') {
    const chainId = params.chainId ?? 137;
    sessionSource({ wallet: params.walletName, chainId, symbol: params.symbol });
    // It sells for USDC on the same chain, which must be covered too.
    sessionDestination({ wallet: params.walletName, chainId, symbol: 'USDC' });
    return;
  }
  if (params.chainId !== undefined) {
    sessionDestination({
      wallet: params.walletName,
      chainId: params.chainId,
      symbol: params.symbol
    });
    return;
  }
  // Without a chain, the buy pays with a covered stablecoin and delivers on
  // that stablecoin's chain, so some chain must cover both.
  const chains = readApprovedPlan(params.walletName)?.plan.chains ?? [];
  const fits = chains.some(
    (chain) =>
      destinationCovered({
        wallet: params.walletName,
        chainId: chain.chainId,
        symbol: params.symbol
      }) &&
      supportedTokens(chain.chainId).some(
        (token) =>
          token.kind === 'usd' &&
          covered({ wallet: params.walletName, chainId: chain.chainId, token: token.address })
      )
  );
  if (fits) return;
  throw new CliError({
    code: 'not_covered',
    message: `${params.symbol.toUpperCase()} isn't covered on any chain where the allowance also covers a stablecoin to pay with.`,
    command: addCommand(params.symbol)
  });
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
      message: `No current USD price for ${token.symbol}, so the amount can't be worked out. Try again shortly.`
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

// How the amount was given: in the source token (`<n>`, `<n>%` or `all`), or
// in USD: --amount-usd, or an exact-output buy's value at current prices (on
// the destination chain), which only estimates what its quote will cost.
type Sizing =
  | { kind: 'units'; amount: string }
  | { kind: 'usd'; usdOn: (destinationChainId: number) => Promise<number> };

// The source amount for a token: what it sells, or an exact-output buy's estimate.
async function sized(params: {
  token: ResolvedToken;
  sizing: Sizing;
  destinationChainId: number;
  balance: () => Promise<bigint>;
  priceOf: (token: ResolvedToken) => Promise<number>;
}): Promise<bigint> {
  const { token, sizing } = params;
  if (sizing.kind === 'usd') {
    return unitsForUsd({
      usd: await sizing.usdOn(params.destinationChainId),
      priceUsd: await params.priceOf(token),
      decimals: token.decimals
    });
  }
  const bps = shareBps(sizing.amount);
  if (bps !== null && token.address === NATIVE) {
    throw new CliError({
      code: 'invalid_input',
      message: `Give an amount of ${token.symbol}; <n>% and all work for tokens, not the native coin.`
    });
  }
  if (bps !== null) return ((await params.balance()) * bps) / 10_000n;
  if (!/^\d+(\.\d+)?$/.test(sizing.amount.trim())) throw invalidAmount(sizing.amount);
  return parseUnits(sizing.amount.trim(), token.decimals);
}

// A token that can pay for the trade.
interface Source {
  token: ResolvedToken;
  // Units it sells; for an exact-output buy, the estimate (the quote decides).
  amount: bigint;
  // A holding that isn't a stablecoin, picked without the user naming it.
  holding: boolean;
  // Session mode: its on-chain allowance left (null: unlimited, or not read).
  remaining: bigint | null;
}

// Without --from: the covered stablecoins with enough balance (and, in session
// mode, on-chain allowance left) for the amount or estimate, in order: USDC on
// Polygon, USDC on other chains, then other stablecoins. With --chain, only
// that chain. With `payWithHoldings`, an amount in USD can then be paid from
// other covered tokens the wallet holds (WETH, WPOL, …; largest first). Never
// the token bought. At most MAX_QUOTES. If none fits, a token that couldn't be
// priced makes the answer unknown, so its error is thrown rather than
// `insufficient_balance`; a token that can't be sized for another reason (the
// token bought doesn't exist on its chain) is just skipped.
async function defaultSources(params: {
  walletName: string;
  walletAddress: string;
  session: boolean;
  chainId?: number;
  // The bridge's destination; without it, the trade delivers on the source's chain.
  toChainId?: number;
  sizing: Sizing;
  payWithHoldings: boolean;
  // Only chains the trade can deliver on (a session buy stays on its chain).
  usableChain?: (chainId: number) => boolean;
  // Whether a token is the one bought (it never pays for itself).
  isBought: (token: ResolvedToken) => Promise<boolean>;
  priceOf: (token: ResolvedToken) => Promise<number>;
  // What's bought, for the error when no chain fits.
  buying?: string;
}): Promise<Source[]> {
  const chainIds = (params.chainId !== undefined ? [params.chainId] : supportedChainIds()).filter(
    (chainId) => params.usableChain?.(chainId) ?? true
  );
  const usable = chainIds
    .flatMap((chainId) => supportedTokens(chainId).map((token) => ({ chainId, ...token })))
    .filter(
      (token) =>
        !params.session ||
        covered({ wallet: params.walletName, chainId: token.chainId, token: token.address })
    );
  const isStable = (token: ResolvedToken) =>
    findSupportedToken({ chainId: token.chainId, address: token.address })?.kind === 'usd';
  const stables = usable.filter(isStable);
  const rank = (token: ResolvedToken) =>
    (token.symbol === 'USDC' ? 0 : 2) + (token.chainId === 137 ? 0 : 1);
  stables.sort((a, b) => rank(a) - rank(b));
  const others =
    params.payWithHoldings && params.sizing.kind === 'usd'
      ? usable.filter((token) => !isStable(token))
      : [];
  if (stables.length === 0 && others.length === 0) {
    throw new CliError({
      code: 'not_covered',
      message: params.usableChain
        ? `No covered stablecoin on a chain where ${params.buying ?? 'the token'} is covered. Name the token to sell with --from, or cover ${params.buying ?? 'it'} on a chain you hold stablecoins on.`
        : 'No covered stablecoin to pay with. Name the token to sell with --from.',
      ...(params.usableChain && params.buying ? { command: addCommand(params.buying) } : {})
    });
  }

  const holdings = await walletHoldings({
    wallet: params.walletName,
    walletAddress: params.walletAddress,
    chainIds: [...new Set([...stables, ...others].map((token) => token.chainId))]
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

  // Only tokens the wallet holds are checked against the token bought (which
  // may take a lookup per chain in owner mode).
  const held = async (tokens: ResolvedToken[]) => {
    const out: ResolvedToken[] = [];
    for (const token of tokens) {
      if (balanceOf(token) > 0n && !(await params.isBought(token))) out.push(token);
    }
    return out;
  };
  // A missing price leaves affordability unknown; other failures just skip the token.
  let unpriced: unknown;
  const priceFailed = (error: unknown) => {
    if (!(error instanceof CliError) || error.code !== 'upstream_unavailable') return;
    unpriced ??= error;
  };

  // Other holdings, largest in USD first.
  const valued: Array<{ token: ResolvedToken; usd: number }> = [];
  for (const token of await held(others)) {
    try {
      const price = await params.priceOf(token);
      valued.push({ token, usd: Number(formatUnits(balanceOf(token), token.decimals)) * price });
    } catch (error) {
      priceFailed(error);
    }
  }
  valued.sort((a, b) => b.usd - a.usd);

  const sources: Source[] = [];
  for (const { token, holding } of [
    ...(await held(stables)).map((token) => ({ token, holding: false })),
    ...valued.map(({ token }) => ({ token, holding: true }))
  ]) {
    if (sources.length === MAX_QUOTES) break;
    const balance = balanceOf(token);
    let amount: bigint;
    try {
      amount = await sized({
        token,
        sizing: params.sizing,
        destinationChainId: params.toChainId ?? token.chainId,
        balance: async () => balance,
        priceOf: params.priceOf
      });
    } catch (error) {
      priceFailed(error);
      continue;
    }
    if (amount === 0n || amount > balance) continue;
    let remaining: bigint | null = null;
    if (params.session) {
      // Needs a live session for it (planned isn't enough), with room left.
      const live = sessionForToken({ sessions, chainId: token.chainId, token: token.address });
      if (!live) continue;
      if (live.grant.remaining !== null && amount > live.grant.remaining) continue;
      remaining = live.grant.remaining;
    }
    sources.push({ token, amount, holding, remaining });
  }
  if (sources.length > 0) return sources;
  if (unpriced !== undefined) throw unpriced;
  const where = params.chainId !== undefined ? ` on ${chainLabel(params.chainId)}` : '';
  throw new CliError({
    code: 'insufficient_balance',
    message: `No covered ${others.length ? 'token' : 'stablecoin'}${where} holds enough for this trade${params.session ? ' within the allowance' : ''}.`,
    hint: 'Name the token to sell with --from, or use a smaller amount.'
  });
}

// A token to buy, as this mode resolves it (owner mode: "POL" is the native coin).
async function destinationToken(params: {
  session: boolean;
  walletName: string;
  chainId: number;
  symbol: string;
}): Promise<ResolvedToken> {
  return params.session
    ? sessionDestination({
        wallet: params.walletName,
        chainId: params.chainId,
        symbol: params.symbol
      })
    : ownerToken({ chainId: params.chainId, symbol: params.symbol });
}

function sameToken(a: ResolvedToken, b: ResolvedToken): boolean {
  return a.chainId === b.chainId && a.address.toLowerCase() === b.address.toLowerCase();
}

// An amount to receive in the token's units. Digits the token can't hold are
// refused rather than dropped: the buy would be for less than was asked.
function exactUnits(params: { amount: string; token: ResolvedToken }): bigint {
  const { amount, token } = params;
  const fraction = amount.split('.')[1] ?? '';
  if (/[1-9]/.test(fraction.slice(token.decimals))) {
    throw new CliError({
      code: 'invalid_input',
      message: `${amount} has more decimals than ${token.symbol} has (${token.decimals}).`
    });
  }
  const units = parseUnits(amount, token.decimals);
  if (units === 0n) {
    throw new CliError({
      code: 'invalid_input',
      message: `${amount} ${token.symbol} is below the token's smallest unit.`
    });
  }
  return units;
}

// The quote's cost is more than the source can pay: the next source may.
class ShortError extends CliError {}

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

  const given = [params.amount, params.amountUsd, params.toAmount].filter((v) => v !== undefined);
  if (given.length !== 1) {
    throw new CliError({
      code: 'invalid_input',
      message: 'Give exactly one of --amount, --amount-usd or --to-amount.'
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
  const toAmount = params.toAmount?.trim();
  if (toAmount !== undefined && (!/^\d+(\.\d+)?$/.test(toAmount) || Number(toAmount) <= 0)) {
    throw new CliError({
      code: 'invalid_input',
      message: `Not an amount to buy: "${params.toAmount}". Use a positive number.`
    });
  }
  if (params.amountUsd !== undefined) {
    if (!Number.isFinite(params.amountUsd) || params.amountUsd <= 0) {
      throw new CliError({ code: 'invalid_input', message: '--amount-usd must be positive.' });
    }
  }

  const resolveDestination = (chainId: number) =>
    destinationToken({ session, walletName: params.walletName, chainId, symbol: params.to });
  // The token bought on each chain, as this mode resolves it (none if it doesn't).
  const bought = new Map<number, Promise<ResolvedToken | undefined>>();
  const boughtOn = (chainId: number): Promise<ResolvedToken | undefined> => {
    let token = bought.get(chainId);
    if (!token) {
      token = resolveDestination(chainId).catch(() => undefined);
      bought.set(chainId, token);
    }
    return token;
  };
  // Prices, once per token for this quote.
  const prices = new Map<string, Promise<number>>();
  const priceOf = (token: ResolvedToken): Promise<number> => {
    const key = priceKey({ chainId: token.chainId, address: token.address });
    let price = prices.get(key);
    if (!price) {
      price = usdPrice(token);
      prices.set(key, price);
    }
    return price;
  };
  // The token bought on a chain, or its resolution error.
  const destinationOn = async (chainId: number) =>
    (await boughtOn(chainId)) ?? resolveDestination(chainId);
  // An exact-output buy is sized by what it receives, at current prices.
  const usdOfBuy = async (chainId: number): Promise<number> =>
    Number(toAmount) * (await priceOf(await destinationOn(chainId)));
  const sizing: Sizing =
    toAmount !== undefined
      ? { kind: 'usd', usdOn: usdOfBuy }
      : params.amountUsd !== undefined
        ? { kind: 'usd', usdOn: async () => params.amountUsd ?? 0 }
        : { kind: 'units', amount: params.amount ?? '' };

  const chainId = params.chain ? resolveNetwork(params.chain).chainId : undefined;
  const toChainId = params.toChain ? resolveNetwork(params.toChain).chainId : undefined;
  if (toAmount !== undefined) {
    // Before picking a source, which would only find nothing to pay (on
    // Polygon without a chain; each quote checks its own destination again).
    const target = await boughtOn(toChainId ?? chainId ?? 137);
    if (target) exactUnits({ amount: toAmount, token: target });
  }

  let sources: Source[];
  if (params.from) {
    const originChainId = chainId ?? 137;
    const token = session
      ? sessionSource({ wallet: params.walletName, chainId: originChainId, symbol: params.from })
      : await ownerToken({ chainId: originChainId, symbol: params.from });
    const amount = await sized({
      token,
      sizing,
      destinationChainId: toChainId ?? originChainId,
      priceOf,
      balance: () =>
        tokenBalance({
          wallet: params.walletName,
          chainId: token.chainId,
          token: getAddress(token.address),
          walletAddress
        })
    });
    sources = [{ token, amount, holding: false, remaining: null }];
  } else {
    sources = await defaultSources({
      walletName: params.walletName,
      walletAddress,
      session,
      chainId,
      toChainId,
      sizing,
      payWithHoldings: params.payWithHoldings ?? false,
      isBought: async (token) => {
        const target = await boughtOn(toChainId ?? token.chainId);
        return target !== undefined && sameToken(token, target);
      },
      priceOf,
      // A session buy delivers on the source's chain, so only chains where the
      // token bought is covered can pay.
      ...(session && toChainId === undefined
        ? {
            usableChain: (candidate: number) =>
              destinationCovered({
                wallet: params.walletName,
                chainId: candidate,
                symbol: params.to
              }),
            buying: params.to.toUpperCase()
          }
        : {})
    });
  }

  if (!process.env.TRAILS_API_KEY && !process.env.SEQUENCE_PROJECT_ACCESS_KEY) {
    await ensureBuilderAccess(walletAddress);
  }
  const { TradeType } = await import('@0xtrails/api');
  const trails = await trailsClient();

  // One source's quote. An exact-output quote costing more than the source's
  // balance or allowance left throws ShortError, so the next source is tried.
  const quoteFrom = async (source: Source) => {
    const origin = source.token;
    let amount = source.amount;
    if (amount <= 0n) {
      throw new CliError({
        code: 'insufficient_balance',
        message: `Nothing to trade: the amount of ${origin.symbol} comes to 0.`
      });
    }
    const destination = await destinationOn(toChainId ?? origin.chainId);
    if (sameToken(origin, destination)) {
      throw new CliError({
        code: 'invalid_input',
        message: 'The source and destination are the same token on the same chain.'
      });
    }
    const exactOutput =
      toAmount !== undefined ? exactUnits({ amount: toAmount, token: destination }) : undefined;

    const { intent } = await trails
      .quoteIntent({
        ownerAddress: walletAddress,
        originChainId: origin.chainId,
        originTokenAddress: origin.address,
        destinationChainId: destination.chainId,
        destinationTokenAddress: destination.address,
        destinationToAddress: walletAddress,
        ...(exactOutput === undefined
          ? { originTokenAmount: amount, tradeType: TradeType.EXACT_INPUT }
          : { destinationTokenAmount: exactOutput, tradeType: TradeType.EXACT_OUTPUT }),
        options: { slippageTolerance: slippage }
      })
      .catch(async (error: unknown) => {
        throw await trailsError(error);
      });
    // An exact-output buy deposits what Trails quotes; `amount` was the estimate.
    const estimate = amount;
    if (exactOutput !== undefined) amount = BigInt(intent.quote?.fromAmount ?? 0n);
    validateDeposit({
      intent,
      walletAddress,
      originChainId: origin.chainId,
      originToken: origin.address,
      destinationChainId: destination.chainId,
      destinationToken: destination.address,
      amount,
      slippage,
      ...(exactOutput !== undefined ? { exactOutput } : {})
    });

    if (exactOutput !== undefined) {
      const cost = `Buying ${toAmount} ${destination.symbol} costs ${formatUnits(amount, origin.decimals)} ${origin.symbol}`;
      // A native source isn't in the token balances; its deposit fails alone.
      if (origin.address !== NATIVE) {
        const balance = await tokenBalance({
          wallet: params.walletName,
          chainId: origin.chainId,
          token: getAddress(origin.address),
          walletAddress
        });
        if (amount > balance) {
          throw new ShortError({
            code: 'insufficient_balance',
            message: `${cost}, more than the wallet holds.`,
            hint: params.from
              ? 'Use a smaller amount.'
              : 'Use a smaller amount, or name the token to sell with --from.'
          });
        }
      }
      if (source.remaining !== null && amount > source.remaining) {
        throw new ShortError({
          code: 'insufficient_balance',
          message: `${cost}, more than the allowance has left for it.`,
          hint: 'Use a smaller amount, or raise the allowance.'
        });
      }
    }
    return { origin, destination, amount, estimate, exactOutput, intent };
  };

  // Estimates only rank the sources: each quote decides, up to MAX_QUOTES.
  let quoted: Awaited<ReturnType<typeof quoteFrom>> | undefined;
  let holding = false;
  let short: unknown;
  for (const source of sources.slice(0, MAX_QUOTES)) {
    try {
      quoted = await quoteFrom(source);
      holding = source.holding;
      break;
    } catch (error) {
      // After a shortfall, a later source's failure (no route, …) only ends
      // the search: the shortfall is the clearer answer.
      if (!(error instanceof ShortError) && short === undefined) throw error;
      short ??= error;
    }
  }
  if (!quoted) throw short;
  const { origin, destination, amount, estimate, exactOutput, intent } = quoted;

  const warnings: string[] = [];
  const fromUsd = intent.quote?.fromAmountUsd ?? 0;
  const feeUsd = intent.fees?.totalFeeUsd ?? 0;
  const toUsd = intent.quote?.toAmountUsd ?? 0;
  const feeShare = fromUsd > 0 ? feeUsd / fromUsd : 0;
  // What the trade gives up in value: fees and price impact together (a thin
  // route can cost far more than its fees).
  const lossShare = fromUsd > 0 && toUsd > 0 ? (fromUsd - toUsd) / fromUsd : 0;
  // An exact-output buy, against our own prices: what it costs over the estimate.
  const overShare =
    exactOutput !== undefined && estimate > 0n ? Number(amount - estimate) / Number(estimate) : 0;
  const highFee =
    feeShare > HIGH_FEE_SHARE || lossShare > HIGH_FEE_SHARE || overShare > HIGH_FEE_SHARE;
  if (feeShare > HIGH_FEE_SHARE) {
    warnings.push(
      `Fees are $${feeUsd.toFixed(2)}, ${Math.round(feeShare * 100)}% of the $${fromUsd.toFixed(2)} being traded.`
    );
  } else if (lossShare > HIGH_FEE_SHARE) {
    warnings.push(
      `It returns $${toUsd.toFixed(2)} for the $${fromUsd.toFixed(2)} being traded, ${Math.round(lossShare * 100)}% less after fees and price impact.`
    );
  } else if (overShare > HIGH_FEE_SHARE) {
    warnings.push(
      `It costs ${formatUnits(amount, origin.decimals)} ${origin.symbol}, ${Math.round(overShare * 100)}% more than ${toAmount} ${destination.symbol} is worth at current prices.`
    );
  }
  if (holding) {
    warnings.push(
      `No covered stablecoin holds enough, so this pays with ${formatUnits(amount, origin.decimals)} ${origin.symbol} (about $${fromUsd.toFixed(2)}).`
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
    depositAddress: intent.originIntentAddress,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
  saveTrade(trade);
  return { trade, warnings, highFee, paidWithHolding: holding };
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
    // Records written before the fix may hold "null".
    ...(trade.receivedAmount && /^\d+$/.test(trade.receivedAmount)
      ? { received: formatUnits(trade.receivedAmount, destination.decimals) }
      : {}),
    ...(trade.destinationTxHash ? { destinationTxHash: trade.destinationTxHash } : {}),
    ...(trade.refundTxHash ? { refundTxHash: trade.refundTxHash } : {}),
    ...(trade.error ? { error: trade.error } : {})
  };
}

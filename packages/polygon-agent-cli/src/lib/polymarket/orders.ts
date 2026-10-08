// Buying and selling outcome shares on the trading account, with a worst-price
// guard checked before anything is posted.

import { CliError } from '../errors.ts';
import { getTradingClient, pusdBalance } from './account.ts';
import { formatUnits6, parseShares, parseUsd } from './amounts.ts';
import { PolymarketError } from './gamma.ts';
import { assertCanOpen, assertCanTrade, checkRegion } from './region.ts';
import { resolveOutcome } from './resolve.ts';
import { loadSdk, mapSdkError } from './sdk.ts';

export type BuyRequest = {
  wallet: string;
  ref: string;
  outcome: string;
  usd: string;
  maxPrice?: number;
  limitPrice?: number;
  expiresMinutes?: number;
  broadcast: boolean;
};
export type SellRequest = {
  wallet: string;
  ref: string;
  outcome: string;
  shares: string;
  minPrice?: number;
  limitPrice?: number;
  expiresMinutes?: number;
  broadcast: boolean;
};

const builder = () =>
  process.env.POLYMARKET_BUILDER_CODE ? { builderCode: process.env.POLYMARKET_BUILDER_CODE } : {};

function expiration(minutes?: number): { expiration?: number } {
  if (minutes === undefined) return {};
  if (!(minutes >= 3)) {
    throw new CliError({ code: 'invalid_input', message: '--expires must be at least 3 minutes.' });
  }
  return { expiration: Math.floor(Date.now() / 1000) + Math.round(minutes * 60) };
}

// An expiry only applies to a resting limit order.
function checkExpiresNeedsLimit(req: { limitPrice?: number; expiresMinutes?: number }): void {
  if (req.expiresMinutes !== undefined && req.limitPrice === undefined) {
    throw new CliError({
      code: 'invalid_input',
      message: '--expires only applies to a limit order (--price); a market order fills at once.'
    });
  }
}

function checkPrice(name: string, p?: number): void {
  if (p !== undefined && !(p > 0 && p < 1)) {
    throw new CliError({ code: 'invalid_input', message: `${name} must be between 0 and 1.` });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeOrderResponse(res: any, side: 'BUY' | 'SELL'): Record<string, unknown> {
  if (!res?.ok) {
    throw new CliError({
      code: 'order_rejected',
      message: res?.message ?? 'Order rejected',
      details: { venueCode: res?.code }
    });
  }
  return {
    orderId: res.orderId,
    status: res.status,
    filledUsd: side === 'BUY' ? res.makingAmount : res.takingAmount,
    filledShares: side === 'BUY' ? res.takingAmount : res.makingAmount,
    txHashes: res.transactionsHashes ?? []
  };
}

const floor2 = (n: number) => Math.floor(n * 100) / 100;

export async function buy(req: BuyRequest): Promise<Record<string, unknown>> {
  checkPrice('--max-price', req.maxPrice);
  checkPrice('--price', req.limitPrice);
  if (req.limitPrice !== undefined && req.maxPrice !== undefined) {
    throw new CliError({
      code: 'invalid_input',
      message:
        'Use either --price (a limit order) or --max-price (a guarded market order), not both.'
    });
  }
  checkExpiresNeedsLimit(req);
  const units = parseUsd(req.usd);
  const usd = formatUnits6(units);
  const { root } = await loadSdk();
  try {
    const client = await getTradingClient(req.wallet);
    assertCanOpen(await checkRegion(client));
    const r = await resolveOutcome(req.ref, req.outcome);
    if (r.market.state?.closed || r.market.state?.acceptingOrders === false) {
      throw new PolymarketError(
        'market_not_accepting_orders',
        `Market ${r.market.slug ?? r.market.conditionId} is not accepting orders${r.market.state?.closed ? ' (closed)' : ''}.`
      );
    }
    const held = await pusdBalance(req.wallet);
    if (held < units) {
      throw new CliError({
        code: 'insufficient_pusd',
        message: `The Polymarket wallet holds $${formatUnits6(held)} pUSD; the order needs $${usd}.`,
        hint: `agent polymarket deposit ${usd} --wallet ${req.wallet} --broadcast`
      });
    }
    const base = { market: r.market.slug, outcome: r.label, assetId: r.assetId, amountUsd: usd };
    if (req.limitPrice !== undefined) {
      const size = floor2(Number(usd) / req.limitPrice);
      if (!(size > 0)) {
        throw new CliError({
          code: 'invalid_input',
          message: `$${usd} buys no whole 0.01 share at ${req.limitPrice}.`
        });
      }
      const order = {
        assetId: r.assetId,
        side: root.OrderSide.BUY,
        price: req.limitPrice,
        size,
        ...expiration(req.expiresMinutes),
        ...builder()
      };
      if (!req.broadcast) {
        return { dryRun: true, ...base, orderType: 'limit', price: req.limitPrice, size };
      }
      return { ...base, ...normalizeOrderResponse(await client.placeLimitOrder(order), 'BUY') };
    }
    const est: number = await client.estimateMarketPrice({
      assetId: r.assetId,
      side: root.OrderSide.BUY,
      amount: usd
    });
    if (req.maxPrice !== undefined && est > req.maxPrice) {
      throw new CliError({
        code: 'price_guard',
        message: `The estimated fill price ${est} is worse than --max-price ${req.maxPrice}.`,
        details: { estimatedPrice: est, maxPrice: req.maxPrice }
      });
    }
    if (!req.broadcast) {
      return {
        dryRun: true,
        ...base,
        orderType: 'market',
        estimatedPrice: est,
        estimatedShares: floor2(Number(usd) / est)
      };
    }
    const res = await client.placeMarketOrder({
      assetId: r.assetId,
      side: root.OrderSide.BUY,
      amount: usd,
      // All-in cap: taker fees never push the spend past the requested amount.
      maxSpend: usd,
      ...(req.maxPrice !== undefined ? { maxPrice: req.maxPrice } : {}),
      orderType: root.OrderType.FAK,
      ...builder()
    });
    return { ...base, estimatedPrice: est, ...normalizeOrderResponse(res, 'BUY') };
  } catch (err) {
    throw mapSdkError(err);
  }
}

export async function sell(req: SellRequest): Promise<Record<string, unknown>> {
  checkPrice('--min-price', req.minPrice);
  checkPrice('--price', req.limitPrice);
  if (req.limitPrice !== undefined && req.minPrice !== undefined) {
    throw new CliError({
      code: 'invalid_input',
      message:
        'Use either --price (a limit order) or --min-price (a guarded market order), not both.'
    });
  }
  checkExpiresNeedsLimit(req);
  const wanted = parseShares(req.shares);
  const { root, actions } = await loadSdk();
  try {
    const client = await getTradingClient(req.wallet);
    assertCanTrade(await checkRegion(client));
    const r = await resolveOutcome(req.ref, req.outcome);
    // The on-chain balance, refreshed by the CLOB: the Data API's positions lag fills.
    const bal = await actions.updateBalanceAllowance(client, {
      assetType:
        r.market.version === 'v2' ? root.AssetType.CONDITIONAL_V2 : root.AssetType.CONDITIONAL,
      assetId: r.assetId
    } as never);
    const heldShares = Number(formatUnits6(bal.balance));
    const shares = wanted === 'all' ? heldShares : wanted;
    if (!(heldShares > 0) || !(shares > 0) || shares > heldShares) {
      throw new PolymarketError(
        'insufficient_shares',
        `Holding ${heldShares} ${r.label} shares in ${r.market.slug}; asked to sell ${wanted === 'all' ? 'all' : shares}.`
      );
    }
    const base = { market: r.market.slug, outcome: r.label, assetId: r.assetId, shares };
    if (req.limitPrice !== undefined) {
      const order = {
        assetId: r.assetId,
        side: root.OrderSide.SELL,
        price: req.limitPrice,
        size: shares,
        ...expiration(req.expiresMinutes),
        ...builder()
      };
      if (!req.broadcast)
        return { dryRun: true, ...base, orderType: 'limit', price: req.limitPrice };
      return { ...base, ...normalizeOrderResponse(await client.placeLimitOrder(order), 'SELL') };
    }
    const est: number = await client.estimateMarketPrice({
      assetId: r.assetId,
      side: root.OrderSide.SELL,
      shares
    });
    if (req.minPrice !== undefined && est < req.minPrice) {
      throw new CliError({
        code: 'price_guard',
        message: `The estimated fill price ${est} is worse than --min-price ${req.minPrice}.`,
        details: { estimatedPrice: est, minPrice: req.minPrice }
      });
    }
    if (!req.broadcast) {
      return {
        dryRun: true,
        ...base,
        orderType: 'market',
        estimatedPrice: est,
        estimatedUsd: floor2(shares * est)
      };
    }
    const res = await client.placeMarketOrder({
      assetId: r.assetId,
      side: root.OrderSide.SELL,
      shares,
      ...(req.minPrice !== undefined ? { minPrice: req.minPrice } : {}),
      orderType: root.OrderType.FAK,
      ...builder()
    });
    return { ...base, estimatedPrice: est, ...normalizeOrderResponse(res, 'SELL') };
  } catch (err) {
    throw mapSdkError(err);
  }
}

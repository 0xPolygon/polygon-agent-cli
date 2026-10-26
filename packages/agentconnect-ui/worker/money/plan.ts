// The allowance the owner approves for a connection: per chain, each covered
// token's on-chain limit. The same rules as the CLI's (session/plan.ts): each
// token's limit is worth the whole allowance at the price when it was built
// (stablecoins at $1), rounded down to token units. The on-chain limits are the
// hard bound; the USD total across tokens is checked from the spend ledger.

import type { Address } from 'viem';

import type { SmartSessionGrant } from '@polygonlabs/oms-wallet';

import type { TokenKind } from './tokens.ts';

import { MoneyError } from './errors.ts';
import { chainLabel, defaultPlanChains, supportedTokens } from './tokens.ts';

export const MIN_ALLOWANCE_USD = 10;
export const MAX_ALLOWANCE_USD = 100_000;
export const MIN_DAYS = 1;
export const MAX_DAYS = 30;
export const DEFAULT_ALLOWANCE_USD = 1000;
export const DEFAULT_DAYS = 30;

export interface PlanGrant {
  symbol: string;
  token: Address;
  decimals: number;
  kind: TokenKind;
  limit: bigint;
  priceUsd: number;
}

export interface PlanChain {
  chainId: number;
  sessionId?: string;
  walletId?: string;
  grants: PlanGrant[];
}

export interface Plan {
  allowanceUsd: number;
  days: number;
  expiresAt: string;
  chains: PlanChain[];
}

export const priceKey = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`;

const PRICE_SCALE = 10n ** 12n;

// floor(allowanceUsd × 10^decimals / priceUsd), in integers.
export function limitFor(params: {
  allowanceUsd: number;
  priceUsd: number;
  decimals: number;
}): bigint {
  const cents = BigInt(Math.round(params.allowanceUsd * 100));
  const price = BigInt(Math.round(params.priceUsd * Number(PRICE_SCALE)));
  if (price <= 0n) throw new Error('Price must be positive');
  return (cents * 10n ** BigInt(params.decimals) * PRICE_SCALE) / (price * 100n);
}

export function validateAllowance(params: { allowanceUsd: number; days: number }): void {
  const { allowanceUsd, days } = params;
  if (
    !Number.isFinite(allowanceUsd) ||
    allowanceUsd < MIN_ALLOWANCE_USD ||
    allowanceUsd > MAX_ALLOWANCE_USD
  ) {
    throw new MoneyError({
      code: 'invalid_input',
      message: `The allowance must be between $${MIN_ALLOWANCE_USD} and $${MAX_ALLOWANCE_USD.toLocaleString('en-US')}.`
    });
  }
  if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) {
    throw new MoneyError({
      code: 'invalid_input',
      message: `The period must be ${MIN_DAYS} to ${MAX_DAYS} whole days.`
    });
  }
}

// Wide bands around plausible USD prices, per kind: only a feed that is
// clearly broken falls outside them. A price far too low would make a limit
// far too high.
const PRICE_BANDS: Partial<Record<TokenKind, [number, number]>> = {
  eth: [100, 100_000],
  btc: [1_000, 2_000_000],
  pol: [0.001, 100]
};

function priceFor(params: {
  chainId: number;
  symbol: string;
  address: string;
  kind: TokenKind;
  prices: Map<string, number>;
}): number {
  if (params.kind === 'usd') return 1;
  const price = params.prices.get(priceKey(params.chainId, params.address));
  if (price === undefined) {
    throw new MoneyError({
      code: 'upstream_unavailable',
      message: `No USD price for ${params.symbol} on ${chainLabel(params.chainId)}; not guessing a limit. Try again shortly.`
    });
  }
  const band = PRICE_BANDS[params.kind];
  if (band && !(price >= band[0] && price <= band[1])) {
    throw new MoneyError({
      code: 'upstream_unavailable',
      message: `The USD price for ${params.symbol} on ${chainLabel(params.chainId)} looks wrong ($${price}); not setting a limit from it. Try again shortly.`
    });
  }
  return price;
}

/** The tokens a new allowance covers: Polygon and Base, plus chains the wallet holds covered tokens on. */
export function planTokens(heldChainIds: Iterable<number>) {
  return defaultPlanChains(heldChainIds).flatMap((chainId) =>
    supportedTokens(chainId).map((token) => ({ ...token, chainId }))
  );
}

export function buildPlan(params: {
  allowanceUsd: number;
  days: number;
  heldChainIds: Iterable<number>;
  prices: Map<string, number>;
  now: Date;
}): Plan {
  validateAllowance(params);
  const chains = new Map<number, PlanChain>();
  for (const token of planTokens(params.heldChainIds)) {
    const chain = chains.get(token.chainId) ?? { chainId: token.chainId, grants: [] };
    chains.set(token.chainId, chain);
    const priceUsd = priceFor({ ...token, prices: params.prices });
    chain.grants.push({
      symbol: token.symbol,
      token: token.address,
      decimals: token.decimals,
      kind: token.kind,
      priceUsd,
      limit: limitFor({ allowanceUsd: params.allowanceUsd, priceUsd, decimals: token.decimals })
    });
  }
  return {
    allowanceUsd: params.allowanceUsd,
    days: params.days,
    expiresAt: new Date(params.now.getTime() + params.days * 86_400_000).toISOString(),
    chains: [...chains.values()].filter((chain) => chain.grants.length > 0)
  };
}

export function toGrants(chain: PlanChain): SmartSessionGrant[] {
  return chain.grants.map((grant) => ({
    kind: 'erc20Transfer',
    token: grant.token,
    limit: grant.limit,
    cumulative: true
  }));
}

// A session matches the plan only if it holds exactly the planned grants:
// cumulative, any-recipient ERC-20 limits and nothing else, until the planned
// expiry (OMS stores it to the second).
export function sessionMatchesPlan(params: {
  session: { chainId: number; expiresAt: string; grants: ReadonlyArray<SmartSessionGrant> };
  planned: PlanChain;
  expiresAt: string;
}): boolean {
  const { session, planned } = params;
  if (session.chainId !== planned.chainId) return false;
  if (Math.abs(Date.parse(session.expiresAt) - Date.parse(params.expiresAt)) > 1000) return false;
  if (session.grants.length !== planned.grants.length) return false;
  return planned.grants.every((grant) =>
    session.grants.some(
      (g) =>
        g.kind === 'erc20Transfer' &&
        g.token.toLowerCase() === grant.token.toLowerCase() &&
        g.limit === grant.limit &&
        g.to === undefined &&
        g.cumulative === true
    )
  );
}

// Plans cross JSON (requests between the worker and the connection's Durable
// Object) with limits as decimal strings.
export type PlanJson = Omit<Plan, 'chains'> & {
  chains: (Omit<PlanChain, 'grants'> & {
    grants: (Omit<PlanGrant, 'limit'> & { limit: string })[];
  })[];
};

export function planToJson(plan: Plan): PlanJson {
  return {
    ...plan,
    chains: plan.chains.map((chain) => ({
      ...chain,
      grants: chain.grants.map((grant) => ({ ...grant, limit: grant.limit.toString() }))
    }))
  };
}

export function planFromJson(json: PlanJson): Plan {
  return {
    ...json,
    chains: json.chains.map((chain) => ({
      ...chain,
      grants: chain.grants.map((grant) => ({ ...grant, limit: BigInt(grant.limit) }))
    }))
  };
}

// The allowance plan the owner approves: per chain, each covered token's
// on-chain limit. Pure: prices and the current plan come in as inputs.
//
// Each token's limit, on each chain, is worth the whole allowance at the price
// when the plan was built (stablecoins at $1), rounded down to token units.

import type { Address } from 'viem';

import { getAddress } from 'viem';
import { z } from 'zod';

import type { SmartSessionGrant } from '@polygonlabs/oms-wallet';

import type { TokenKind } from './tokens.ts';

import { CliError } from '../errors.ts';
import { priceKey } from '../prices.ts';
import { formatUnits } from '../utils.ts';
import { chainLabel } from './tokens.ts';

export const MIN_ALLOWANCE_USD = 10;
export const MAX_ALLOWANCE_USD = 100_000;
export const MIN_DAYS = 1;
export const MAX_DAYS = 30;
export const DEFAULT_ALLOWANCE_USD = 1000;
export const DEFAULT_DAYS = 30;
export const MAX_GRANTS_PER_CHAIN = 127;

// Whether OMS starts usage at zero when a session's limit changes (FS §6.3).
// If it keeps the old usage instead, a changed limit becomes used + remaining.
export const USAGE_RESETS_ON_LIMIT_CHANGE = true;

export interface PlanToken {
  chainId: number;
  symbol: string;
  address: Address;
  decimals: number;
  kind?: TokenKind;
}

export interface PlanGrant {
  symbol: string;
  token: Address;
  decimals: number;
  kind?: TokenKind;
  limit: bigint;
  priceUsd: number;
}

export interface PlanChain {
  chainId: number;
  sessionId?: string;
  grants: PlanGrant[];
}

export interface Plan {
  allowanceUsd: number;
  days: number;
  expiresAt: string;
  chains: PlanChain[];
}

const PlanGrantSchema = z.object({
  symbol: z.string(),
  token: z.string().transform((value) => getAddress(value)),
  decimals: z.number().int(),
  kind: z.enum(['usd', 'eth', 'btc', 'pol']).optional(),
  limit: z.string().transform((value) => BigInt(value)),
  priceUsd: z.number()
});

export const PlanSchema = z.object({
  allowanceUsd: z.number(),
  days: z.number(),
  expiresAt: z.string(),
  chains: z.array(
    z.object({
      chainId: z.number().int(),
      sessionId: z.string().optional(),
      grants: z.array(PlanGrantSchema)
    })
  )
});

export function planToJson(plan: Plan): unknown {
  return {
    ...plan,
    chains: plan.chains.map((chain) => ({
      ...chain,
      grants: chain.grants.map((grant) => ({ ...grant, limit: grant.limit.toString() }))
    }))
  };
}

export function parsePlan(value: unknown): Plan {
  return PlanSchema.parse(value);
}

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
    throw new CliError({
      code: 'invalid_input',
      message: `The allowance must be between $${MIN_ALLOWANCE_USD} and $${MAX_ALLOWANCE_USD.toLocaleString('en-US')}.`
    });
  }
  if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) {
    throw new CliError({
      code: 'invalid_input',
      message: `The period must be ${MIN_DAYS}–${MAX_DAYS} whole days.`
    });
  }
}

// Wide bands around plausible USD prices, per kind (not targets: only a feed
// that is clearly broken falls outside them).
const PRICE_BANDS: Partial<Record<TokenKind, [number, number]>> = {
  eth: [100, 100_000],
  btc: [1_000, 2_000_000],
  pol: [0.001, 100]
};

function priceFor(params: { token: PlanToken; prices: Map<string, number> }): number {
  if (params.token.kind === 'usd') return 1;
  const price = params.prices.get(
    priceKey({ chainId: params.token.chainId, address: params.token.address })
  );
  if (price === undefined) {
    throw new CliError({
      code: 'upstream_unavailable',
      message: `No USD price for ${params.token.symbol} on ${chainLabel(params.token.chainId)}; not guessing a limit. Try again shortly.`
    });
  }
  // The on-chain limit is the allowance at this price: a wrong price (a bad
  // feed, a misconfigured price host) far too low would make the limit far too
  // high. Prices outside a wide sane band are refused.
  const band = params.token.kind ? PRICE_BANDS[params.token.kind] : undefined;
  if (band && !(price >= band[0] && price <= band[1])) {
    throw new CliError({
      code: 'upstream_unavailable',
      message: `The USD price for ${params.token.symbol} on ${chainLabel(params.token.chainId)} looks wrong ($${price}); not setting a limit from it. Try again shortly.`
    });
  }
  return price;
}

// Builds a plan for `tokens` (grouped by chain, in order). With `current`
// (an allowance change), existing sessions keep their ids and expiry, tokens
// not in `tokens` keep their entries, and limits only change when the
// allowance does or the token is new.
export function buildPlan(params: {
  allowanceUsd: number;
  days: number;
  tokens: PlanToken[];
  prices: Map<string, number>;
  now: Date;
  current?: Plan;
  // Used amounts by token, per chain, when USAGE_RESETS_ON_LIMIT_CHANGE is false.
  used?: Map<string, bigint>;
}): Plan {
  validateAllowance({ allowanceUsd: params.allowanceUsd, days: params.days });
  const { current } = params;
  const allowanceChanged = current !== undefined && current.allowanceUsd !== params.allowanceUsd;

  const chains = new Map<number, PlanChain>();
  for (const chain of current?.chains ?? []) {
    chains.set(chain.chainId, { ...chain, grants: chain.grants.map((grant) => ({ ...grant })) });
  }

  for (const token of params.tokens) {
    const chain = chains.get(token.chainId) ?? { chainId: token.chainId, grants: [] };
    chains.set(token.chainId, chain);
    if (chain.grants.some((grant) => grant.token.toLowerCase() === token.address.toLowerCase())) {
      continue;
    }
    chain.grants.push({
      symbol: token.symbol,
      token: token.address,
      decimals: token.decimals,
      kind: token.kind,
      limit: 0n,
      priceUsd: priceFor({ token, prices: params.prices })
    });
  }

  for (const chain of chains.values()) {
    if (chain.grants.length > MAX_GRANTS_PER_CHAIN) {
      throw new CliError({
        code: 'too_many_tokens',
        message: `${chainLabel(chain.chainId)} would cover ${chain.grants.length} tokens; a session holds at most ${MAX_GRANTS_PER_CHAIN}.`
      });
    }
    for (const grant of chain.grants) {
      const isNew = grant.limit === 0n;
      if (!isNew && !allowanceChanged) continue;
      if (!isNew) {
        grant.priceUsd =
          grant.kind === 'usd'
            ? 1
            : priceFor({
                token: { ...grant, chainId: chain.chainId, address: grant.token },
                prices: params.prices
              });
      }
      const remaining = limitFor({
        allowanceUsd: params.allowanceUsd,
        priceUsd: grant.priceUsd,
        decimals: grant.decimals
      });
      const used = USAGE_RESETS_ON_LIMIT_CHANGE
        ? 0n
        : (params.used?.get(priceKey({ chainId: chain.chainId, address: grant.token })) ?? 0n);
      grant.limit = remaining + used;
    }
  }

  const expiresAt =
    current?.expiresAt ?? new Date(params.now.getTime() + params.days * 86_400_000).toISOString();
  return {
    allowanceUsd: params.allowanceUsd,
    days: current?.days ?? params.days,
    expiresAt,
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

// What the assistant shows the owner before asking for a code.
export function planSummary(plan: Plan): Record<string, unknown> {
  const usd = plan.allowanceUsd.toLocaleString('en-US');
  const perChain = plan.chains.map(
    (chain) =>
      `${chain.grants.map((grant) => grant.symbol).join(', ')} on ${chainLabel(chain.chainId)}`
  );
  return {
    allowanceUsd: plan.allowanceUsd,
    days: plan.days,
    expiresAt: plan.expiresAt,
    chains: plan.chains.map((chain) => ({
      chain: chainLabel(chain.chainId),
      chainId: chain.chainId,
      ...(chain.sessionId ? { sessionId: chain.sessionId } : {}),
      tokens: chain.grants.map((grant) => ({
        symbol: grant.symbol,
        address: grant.token,
        limit: formatUnits(grant.limit, grant.decimals),
        priceUsd: grant.priceUsd
      }))
    })),
    summary:
      `Spend up to $${usd} in total until ${plan.expiresAt.slice(0, 10)}: ${perChain.join('; ')}. ` +
      `On-chain, the agent can't move more than $${usd} worth of any one token on any one chain.`
  };
}

// Request-body schemas for the Worker's JSON entry points, so a malformed body
// is refused at the edge instead of failing deep in a handler.
//
// Messages for the string fields match the hand checks they replaced
// ("<field> is required"), because the pages show them to the owner.

import { z } from 'zod/v4';

import type { KeyRequest, WalletStoreRequest } from './money/agent-key.ts';
import type { MoneyCode } from './money/errors.ts';

const requiredString = (name: string) =>
  z.string(`${name} is required`).trim().min(1, `${name} is required`);

// The connect page may post without an id (a stale link): the handler then
// answers "This sign-in expired", so a missing id defaults rather than fails.
const optionalId = z.string('c must be a string').default('');

const jsonObject = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape, 'Request body must be a JSON object');

// Sign-in steps shared by the connect page, the approval page and the site.
export const EmailStartBody = jsonObject({ email: requiredString('email') });
export const EmailFinishBody = jsonObject({ c: requiredString('c'), code: requiredString('code') });
export const GoogleFinishBody = jsonObject({
  c: requiredString('c'),
  callbackUrl: requiredString('callbackUrl')
});

export const ConnectEmailStartBody = jsonObject({ c: optionalId, email: requiredString('email') });
export const ConnectEmailFinishBody = jsonObject({ c: optionalId, code: requiredString('code') });
export const ConnectGoogleStartBody = jsonObject({ c: optionalId });
export const ConnectGoogleFinishBody = jsonObject({
  c: optionalId,
  callbackUrl: requiredString('callbackUrl')
});
// Anything but `allow: true` is a refusal. The allowance and period are range-checked
// by the allowance setup, which answers invalid_input, so a missing one stays NaN for it.
export const ConnectDecideBody = jsonObject({
  c: optionalId,
  allow: z.boolean().optional(),
  allowanceUsd: z.number().optional(),
  days: z.number().optional()
});

export const ActionDecideBody = jsonObject({
  approve: z.boolean().optional(),
  c: z.string().optional()
});

// JSON-RPC: the envelope is checked here and each method's params where it is read.
// "jsonrpc" is not required because clients that omit it are served today.
export const RpcMessage = z.object({
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional()
});
export type Rpc = z.infer<typeof RpcMessage>;

export const ToolCallParams = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).nullish()
});

// What the Worker sends a connection's Durable Object. Objects are loose so
// fields passed on whole (swap and payment parameters) survive parsing.
const wallet = z.string();
const optString = z.string().optional();
const ownerRegion = z.object({ country: z.string().nullable(), region: z.string().nullable() });
const pmRegion = { ownerRegion: ownerRegion.optional() };

const hex = z.templateLiteral(['0x', z.string()]);

const planGrant = z.looseObject({
  symbol: z.string(),
  token: hex,
  decimals: z.number(),
  kind: z.enum(['usd', 'eth', 'btc', 'pol']),
  limit: z.string(),
  priceUsd: z.number()
});
const planChain = z.looseObject({
  chainId: z.number(),
  sessionId: optString,
  walletId: optString,
  grants: z.array(planGrant)
});
const planJson = z.looseObject({
  allowanceUsd: z.number(),
  days: z.number(),
  expiresAt: z.string(),
  chains: z.array(planChain)
});

// Every MoneyCode, so an owner_end error from the Worker parses to the real type.
const MONEY_CODES = [
  'invalid_input',
  'not_connected',
  'not_covered',
  'allowance_exhausted',
  'session_expired',
  'session_revoked',
  'insufficient_balance',
  'not_sponsored',
  'native_not_supported',
  'quote_expired',
  'quote_not_found',
  'upstream_invalid_quote',
  'upstream_unavailable',
  'upstream_error',
  'rate_limited',
  'region_blocked',
  'region_close_only',
  'not_set_up',
  'key_missing',
  'below_bridge_minimum',
  'bridge_pending',
  'bridge_failed',
  'insufficient_pusd',
  'insufficient_shares',
  'market_not_accepting_orders',
  'outcome_not_found',
  'ambiguous_market',
  'price_guard',
  'order_rejected'
] as const;
type MissingMoneyCode = Exclude<MoneyCode, (typeof MONEY_CODES)[number]>;
const allMoneyCodesListed: MissingMoneyCode extends never ? true : never = true;
void allMoneyCodesListed;

// The spends, without the wallet (the request a proposal saves).
const spends = {
  send: {
    op: z.literal('send'),
    token: z.string(),
    chain: optString,
    to: z.string(),
    amount: z.string()
  },
  swap: { op: z.literal('swap'), intentId: z.string(), approved: z.boolean().optional() },
  pay_service: {
    op: z.literal('pay_service'),
    url: z.string(),
    method: optString,
    body: optString,
    headers: z.record(z.string(), z.string()).optional(),
    // A missing amount crosses JSON as null; the payment's own check refuses NaN.
    maxUsd: z
      .number()
      .nullable()
      .transform((v) => v ?? Number.NaN),
    chain: z.number().optional()
  },
  pm_deposit: { op: z.literal('pm_deposit'), ...pmRegion, usd: z.string() },
  pm_buy: {
    op: z.literal('pm_buy'),
    ...pmRegion,
    market: z.string(),
    outcome: z.string(),
    usd: z.string(),
    maxPrice: z.number().optional(),
    limitPrice: z.number().optional()
  },
  pm_sell: {
    op: z.literal('pm_sell'),
    ...pmRegion,
    market: z.string(),
    outcome: z.string(),
    shares: z.string(),
    minPrice: z.number().optional(),
    limitPrice: z.number().optional()
  },
  earn_deposit: {
    op: z.literal('earn_deposit'),
    appName: z.string(),
    vault: z.string(),
    amount: z.string(),
    chain: optString
  }
};

const spendRequest = z.discriminatedUnion('op', [
  z.looseObject(spends.send),
  z.looseObject(spends.swap),
  z.looseObject(spends.pay_service),
  z.looseObject(spends.pm_deposit),
  z.looseObject(spends.pm_buy),
  z.looseObject(spends.pm_sell),
  z.looseObject(spends.earn_deposit)
]);

const forWallet = <T extends z.ZodRawShape>(shape: T) => z.looseObject({ wallet, ...shape });

export const AgentKeyRequest = z.discriminatedUnion('op', [
  forWallet({
    op: z.literal('register'),
    days: z.number(),
    appName: z.string()
  }),
  forWallet({
    op: z.literal('approve'),
    plan: planJson,
    approved: z.array(
      z.looseObject({ chainId: z.number(), sessionId: z.string(), walletId: z.string() })
    )
  }),
  forWallet({ op: z.literal('status') }),
  forWallet(spends.send),
  forWallet({
    op: z.literal('swap_quote'),
    from: z.string(),
    to: z.string(),
    amount: optString,
    amountUsd: z.number().optional(),
    toAmount: optString,
    chain: optString,
    toChain: optString,
    slippage: z.number().optional(),
    call: z.looseObject({ to: z.string(), data: z.string() }).optional()
  }),
  forWallet(spends.swap),
  forWallet({ op: z.literal('swap_status'), intentId: z.string() }),
  forWallet(spends.pay_service),
  forWallet({ op: z.literal('earn_vaults'), chain: optString }),
  forWallet(spends.earn_deposit),
  forWallet({
    op: z.literal('earn_withdraw'),
    appName: z.string(),
    vault: z.string(),
    amount: z.string(),
    chain: optString
  }),
  forWallet({ op: z.literal('pm_markets'), query: optString }),
  forWallet({ op: z.literal('pm_account'), ...pmRegion }),
  forWallet(spends.pm_deposit),
  forWallet(spends.pm_buy),
  forWallet(spends.pm_sell),
  forWallet({
    op: z.literal('pm_cancel'),
    ...pmRegion,
    orderId: optString,
    market: optString,
    all: z.boolean().optional()
  }),
  forWallet({ op: z.literal('pm_redeem'), ...pmRegion }),
  forWallet({ op: z.literal('pm_withdraw'), ...pmRegion, usd: z.string() }),
  forWallet({ op: z.literal('owner_begin'), id: z.string() }),
  forWallet({
    op: z.literal('owner_end'),
    id: z.string(),
    result: z.unknown().optional(),
    error: z
      .looseObject({
        error: z.string(),
        code: z.enum(MONEY_CODES),
        hint: optString,
        details: z.record(z.string(), z.unknown()).optional()
      })
      .optional()
  }),
  forWallet({ op: z.literal('revoke') }),
  forWallet({ op: z.literal('propose'), appName: z.string(), request: spendRequest }),
  forWallet({
    op: z.literal('propose_bundle'),
    appName: z.string(),
    steps: z.array(spendRequest)
  }),
  forWallet({ op: z.literal('action'), id: z.string(), waitMs: z.number().optional() }),
  forWallet({ op: z.literal('decide'), id: z.string(), approve: z.boolean() }),
  forWallet({ op: z.literal('owner_seen'), region: ownerRegion }),
  // The wallet's own object: sealed values by name.
  z.looseObject({ op: z.literal('wstore_get'), name: z.string() }),
  z.looseObject({ op: z.literal('wstore_put'), name: z.string(), value: z.string() }),
  z.looseObject({ op: z.literal('wstore_put_new'), name: z.string(), value: z.string() }),
  z.looseObject({ op: z.literal('wstore_lease'), holder: z.string(), until: z.number() }),
  z.looseObject({ op: z.literal('wstore_release'), holder: z.string() })
]) satisfies z.ZodType<KeyRequest | WalletStoreRequest>;

// Refusals and failures the agent can act on: a code, a message for the owner
// and, when there is one, what to do next. The MCP tools return them as tool
// errors, never as JSON-RPC errors, so the agent reads them.

import { isOMSWalletError } from '@polygonlabs/oms-wallet';

export type MoneyCode =
  | 'invalid_input'
  | 'not_connected'
  | 'not_covered'
  | 'allowance_exhausted'
  | 'session_expired'
  | 'session_revoked'
  | 'insufficient_balance'
  | 'not_sponsored'
  | 'native_not_supported'
  | 'quote_expired'
  | 'quote_not_found'
  | 'upstream_invalid_quote'
  | 'upstream_unavailable'
  | 'upstream_error'
  | 'rate_limited'
  // Polymarket
  | 'region_blocked'
  | 'region_close_only'
  | 'not_set_up'
  | 'key_missing'
  | 'below_bridge_minimum'
  | 'bridge_pending'
  | 'bridge_failed'
  | 'insufficient_pusd'
  | 'insufficient_shares'
  | 'market_not_accepting_orders'
  | 'outcome_not_found'
  | 'ambiguous_market'
  | 'price_guard'
  | 'order_rejected';

// A refusal with any of these codes was raised before anything was sent.
export const NOTHING_SENT_CODES: ReadonlySet<MoneyCode> = new Set([
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
  'region_blocked',
  'region_close_only',
  'not_set_up',
  'key_missing',
  'below_bridge_minimum',
  'bridge_pending',
  'insufficient_pusd',
  'insufficient_shares',
  'market_not_accepting_orders',
  'outcome_not_found',
  'ambiguous_market',
  'price_guard'
]);

export class MoneyError extends Error {
  readonly code: MoneyCode;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(params: {
    code: MoneyCode;
    message: string;
    hint?: string;
    details?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(params.message, params.cause === undefined ? undefined : { cause: params.cause });
    this.name = 'MoneyError';
    this.code = params.code;
    this.hint = params.hint;
    this.details = params.details;
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.details ? { details: this.details } : {})
    };
  }
}

export function upstreamErrorName(error: unknown): string | undefined {
  return isOMSWalletError(error) ? error.upstreamError?.name : undefined;
}

export function httpStatus(error: unknown): number | undefined {
  return isOMSWalletError(error) ? (error.status ?? error.upstreamError?.status) : undefined;
}

// A refusal for a connection whose key OMS no longer accepts (401).
export function keyRefused(params: { error: unknown; expiresAt?: string }): MoneyError {
  if (params.expiresAt && Date.parse(params.expiresAt) <= Date.now()) {
    return new MoneyError({
      code: 'session_expired',
      message: "This connection's allowance has expired.",
      hint: 'Ask the owner to connect again from this app to approve a new allowance.',
      cause: params.error
    });
  }
  return new MoneyError({
    code: 'session_revoked',
    message: "This connection's allowance was revoked.",
    hint: 'Ask the owner to connect again from this app.',
    cause: params.error
  });
}

// OMS failures that mean the same thing everywhere; anything else unchanged.
export function mapOmsError(error: unknown): unknown {
  if (error instanceof MoneyError || !isOMSWalletError(error)) return error;
  const status = httpStatus(error);
  if (error.upstreamError?.name === 'OTPRateLimited' || status === 429) {
    return new MoneyError({
      code: 'rate_limited',
      message: 'OMS is rate limiting requests. Wait a minute and try again.',
      cause: error
    });
  }
  if (error.code === 'OMS_REQUEST_FAILED' || (status !== undefined && status >= 500)) {
    return new MoneyError({
      code: 'upstream_unavailable',
      message: 'OMS is unavailable right now. Try again shortly.',
      cause: error
    });
  }
  return error;
}

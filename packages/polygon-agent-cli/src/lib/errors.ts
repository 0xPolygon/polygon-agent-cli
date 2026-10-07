// Errors with a stable code, a hint, and the command to run next, so an
// assistant can act on a failure without parsing the message.
//
// Output on failure: {ok: false, error, code?, hint?, command?, ...details}.

import { isOMSWalletError } from '@polygonlabs/oms-wallet';

export type CliErrorCode =
  | 'not_connected'
  | 'invalid_code'
  | 'request_expired'
  | 'already_connected'
  | 'session_expired'
  | 'session_revoked'
  | 'not_covered'
  | 'allowance_exhausted'
  | 'owner_required'
  | 'native_not_supported'
  | 'insufficient_balance'
  | 'too_many_tokens'
  | 'not_sponsored'
  | 'chain_required'
  | 'invalid_input'
  | 'wallet_busy'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'upstream_error';

export class CliError extends Error {
  code: CliErrorCode;
  hint?: string;
  command?: string;
  details?: Record<string, unknown>;

  constructor(params: {
    code: CliErrorCode;
    message: string;
    hint?: string;
    command?: string;
    details?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = 'CliError';
    this.code = params.code;
    this.hint = params.hint;
    this.command = params.command;
    this.details = params.details;
  }
}

export const bigintReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;

export function errorJson(error: unknown): Record<string, unknown> {
  if (error instanceof CliError) {
    return {
      ok: false,
      error: error.message,
      code: error.code,
      ...(error.hint ? { hint: error.hint } : {}),
      ...(error.command ? { command: error.command } : {}),
      ...error.details
    };
  }
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

// errorJson, plus the stack for an unexpected (non-CLI) error.
export function failureJson(error: unknown): Record<string, unknown> {
  if (error instanceof CliError || !(error instanceof Error)) return errorJson(error);
  return { ...errorJson(error), stack: error.stack };
}

// Prints the failure as JSON on stderr and exits 1.
export function jsonFail(error: unknown): never {
  console.error(JSON.stringify(errorJson(error), bigintReplacer));
  process.exit(1);
}

export function jsonOut(data: Record<string, unknown>): void {
  console.log(JSON.stringify(data, bigintReplacer, 2));
}

// The WaaS error name behind an SDK error, e.g. 'AnswerIncorrect'.
export function upstreamErrorName(error: unknown): string | undefined {
  return isOMSWalletError(error) ? error.upstreamError?.name : undefined;
}

export function httpStatus(error: unknown): number | undefined {
  return isOMSWalletError(error) ? (error.status ?? error.upstreamError?.status) : undefined;
}

// Maps SDK failures that mean the same thing everywhere; returns the error
// unchanged otherwise.
export function mapOmsError(error: unknown): unknown {
  if (error instanceof CliError || !isOMSWalletError(error)) return error;
  const name = error.upstreamError?.name;
  const status = httpStatus(error);
  if (name === 'OTPRateLimited' || status === 429) {
    return new CliError({
      code: 'rate_limited',
      message: 'OMS is rate limiting requests. Wait a minute and try again.',
      cause: error
    });
  }
  if (error.code === 'OMS_REQUEST_FAILED' || (status !== undefined && status >= 500)) {
    return new CliError({
      code: 'upstream_unavailable',
      message: `OMS is unavailable (${error.message}). Try again shortly.`,
      cause: error
    });
  }
  return error;
}

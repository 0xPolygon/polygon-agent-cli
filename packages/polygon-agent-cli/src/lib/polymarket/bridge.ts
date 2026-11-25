// Polymarket's bridge: per-wallet addresses that credit pUSD on deposit, and
// destination-bound addresses that pay out pUSD as another token on withdraw.

import { USDC_POLYGON } from '@polygonlabs/agent-shared';

import { getEnv } from '../env.ts';
import { CliError } from '../errors.ts';

export const BRIDGE_MIN_DEPOSIT_UNITS = 2_000_000n;
// The bridge's minimum checkout applies to withdrawals too: pUSD sent to a withdraw address
// below it is never paid out, and sits at that address.
export const BRIDGE_MIN_WITHDRAW_UNITS = 2_000_000n;

export function builderHeaders(): Record<string, string> {
  const code = getEnv().POLYMARKET_BUILDER_CODE;
  return code ? { 'X-Builder-Code': code } : {};
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${getEnv().POLYMARKET_BRIDGE_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...builderHeaders() },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  } catch (err) {
    throw new CliError({
      code: 'upstream_unavailable',
      message: `Polymarket bridge unreachable: ${(err as Error).message}`,
      cause: err
    });
  }
  const text = await res.text();
  if (!res.ok) {
    throw new CliError({
      code:
        res.status >= 500
          ? 'upstream_unavailable'
          : res.status === 429
            ? 'rate_limited'
            : 'upstream_error',
      message: `Polymarket bridge ${path} failed (${res.status}): ${text.slice(0, 200)}`
    });
  }
  return JSON.parse(text) as T;
}

function evmOf(res: { address?: { evm?: string } }, what: string): string {
  const evm = res.address?.evm;
  if (!evm)
    throw new CliError({
      code: 'upstream_error',
      message: `Polymarket bridge returned no EVM ${what} address.`
    });
  return evm;
}

export async function depositAddress(wallet: string): Promise<string> {
  return evmOf(await call('POST', '/deposit', { address: wallet }), 'deposit');
}

export async function withdrawAddress(params: {
  wallet: string;
  recipient: string;
  toChainId?: number;
  toToken?: string;
}): Promise<string> {
  return evmOf(
    await call('POST', '/withdraw', {
      address: params.wallet,
      toChainId: String(params.toChainId ?? 137),
      toTokenAddress: params.toToken ?? USDC_POLYGON,
      recipientAddr: params.recipient
    }),
    'withdraw'
  );
}

export async function bridgeStatus(
  address: string
): Promise<{ transactions: Array<{ status: string; [k: string]: unknown }> }> {
  const res = await call<{ transactions?: Array<{ status: string }> }>('GET', `/status/${address}`);
  return { transactions: res.transactions ?? [] };
}

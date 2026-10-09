import type { QuoteSwapParams } from './quote.ts';

import { shellQuote } from '../shell.ts';
import { resolveNetwork } from '../utils.ts';

// Amounts, symbols, addresses and chain names read as typed; anything else is
// single-quoted, so nothing in it is expanded.
const PLAIN = /^[\w.%@:/-]+$/;

function shellWord(value: string): string {
  return PLAIN.test(value) ? value : shellQuote(value);
}

// Follow-up commands are previews, never permission to execute a different quote.
export function previewSwapCommand(params: {
  request: QuoteSwapParams;
  source?: { symbol: string; chainId: number };
}): string {
  const { request, source } = params;
  const args = ['swap'];
  if (request.walletName !== 'main') args.push('--wallet', request.walletName);
  args.push('--to', request.to);
  const from = request.from ?? source?.symbol;
  const chain = source ? resolveNetwork(source.chainId).name : request.chain;
  if (from !== undefined) args.push('--from', from);
  if (chain !== undefined) args.push('--chain', chain);
  if (request.toChain !== undefined) args.push('--to-chain', request.toChain);
  if (request.amount !== undefined) args.push('--amount', request.amount);
  if (request.amountUsd !== undefined) args.push('--amount-usd', String(request.amountUsd));
  if (request.toAmount !== undefined) args.push('--to-amount', request.toAmount);
  if (request.slippage !== undefined) args.push('--slippage', String(request.slippage));
  args.push('--dry-run');
  return `polygon-agent ${args.map(shellWord).join(' ')}`;
}

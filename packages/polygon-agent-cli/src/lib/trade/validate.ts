// Checks a Trails quote before anything is sent. The deposit must be exactly a
// transfer of the quoted amount of the source token to the intent's deposit
// address, on the source chain; the trade must belong to and deliver to the
// wallet, with no destination call; and the minimum output must honour the
// slippage asked for (or, for an exact-output buy, be the amount asked for).
// Anything else is refused (upstream_invalid_quote) in both modes: the deposit
// is the only thing the wallet signs.
//
// What happens after the deposit (the routes Trails runs) can't be checked
// locally; that part is trust in Trails.

import { decodeFunctionData, erc20Abi, isAddress, isHex } from 'viem';

import type { Intent } from '@0xtrails/api';

import { CliError } from '../errors.ts';

const NATIVE = '0x0000000000000000000000000000000000000000';

const same = (a: string | undefined, b: string): boolean =>
  typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

function invalid(reason: string): CliError {
  return new CliError({
    code: 'upstream_invalid_quote',
    message: `Trails returned a quote that doesn't match the request (${reason}); nothing was sent.`,
    hint: 'Quote again; if it keeps happening, report it.'
  });
}

export type QuotedIntent = Pick<
  Intent,
  | 'intentId'
  | 'ownerAddress'
  | 'originChainId'
  | 'destinationChainId'
  | 'originTokenAddress'
  | 'destinationTokenAddress'
  | 'originIntentAddress'
  | 'depositTransaction'
  | 'quoteRequest'
  | 'quote'
>;

// The saved deposit, re-checked just before it's sent (`swap --intent` sends
// what trades/<id>.json holds): still exactly the quoted transfer of the
// source token to the deposit address checked at quote time.
export function validateSavedDeposit(trade: {
  intentId: string;
  origin: { token: string; amount: string };
  deposit: { to: string; data: string; value: string };
  depositAddress?: string;
}): void {
  const { origin, deposit, depositAddress } = trade;
  const changed = (reason: string) =>
    new CliError({
      code: 'upstream_invalid_quote',
      message: `The saved trade ${trade.intentId} no longer matches its quote (${reason}); nothing was sent.`,
      hint: 'Quote again.'
    });
  const amount = BigInt(origin.amount);
  const value = BigInt(deposit.value);
  if (same(origin.token, NATIVE)) {
    if (value !== amount || (deposit.data && deposit.data !== '0x')) {
      throw changed('not the quoted native transfer');
    }
    if (depositAddress && !same(deposit.to, depositAddress)) {
      throw changed('another recipient');
    }
    return;
  }
  if (!same(deposit.to, origin.token) || value !== 0n || !isHex(deposit.data)) {
    throw changed('not a call to the token');
  }
  let decoded: ReturnType<typeof decodeFunctionData<typeof erc20Abi>>;
  try {
    decoded = decodeFunctionData({ abi: erc20Abi, data: deposit.data });
  } catch {
    throw changed('not an ERC-20 call');
  }
  if (decoded.functionName !== 'transfer' || decoded.args[1] !== amount) {
    throw changed('not the quoted transfer');
  }
  if (depositAddress && !same(decoded.args[0], depositAddress)) {
    throw changed('another recipient');
  }
}

export function validateDeposit(params: {
  intent: QuotedIntent;
  walletAddress: string;
  originChainId: number;
  originToken: string;
  destinationChainId: number;
  destinationToken: string;
  amount: bigint;
  slippage: number;
  // An exact-output buy: the amount to receive. `amount` is then the quoted input.
  exactOutput?: bigint;
}): void {
  const { intent, walletAddress } = params;
  if (!intent.intentId || !/^[\w-]+$/.test(intent.intentId)) throw invalid('bad intent id');
  if (!same(intent.ownerAddress, walletAddress)) throw invalid('owner is not the wallet');
  const request = intent.quoteRequest;
  if (!request || !same(request.destinationToAddress, walletAddress)) {
    throw invalid('output goes to another address');
  }
  if (
    (request.destinationCallData && request.destinationCallData !== '0x') ||
    request.destinationApproveAddress ||
    BigInt(request.destinationCallValue ?? 0) !== 0n
  ) {
    throw invalid('the output would be used in a contract call');
  }
  const expected = BigInt(intent.quote?.toAmount ?? 0);
  const minimum = BigInt(intent.quote?.toAmountMin ?? 0);
  if (params.exactOutput !== undefined) {
    // Trails puts the slippage on the output: the minimum is what was asked.
    if (request.tradeType !== 'EXACT_OUTPUT') throw invalid('not an exact-output trade');
    if (
      request.destinationTokenAmount === undefined ||
      BigInt(request.destinationTokenAmount) !== params.exactOutput
    ) {
      throw invalid('the quoted amount differs from the request');
    }
    if (minimum < params.exactOutput || expected < minimum) {
      throw invalid('the minimum output is below the amount asked for');
    }
    if (params.amount <= 0n || BigInt(intent.quote?.fromAmount ?? 0) !== params.amount) {
      throw invalid('no input amount');
    }
  } else {
    if (
      request.originTokenAmount === undefined ||
      BigInt(request.originTokenAmount) !== params.amount
    ) {
      throw invalid('the quoted amount differs from the request');
    }
    if (request.tradeType !== undefined && request.tradeType !== 'EXACT_INPUT') {
      throw invalid('not an exact-input trade');
    }
    // The minimum output may sit below the expected output by at most the
    // slippage (plus 0.01% for Trails' rounding).
    const bps = BigInt(Math.ceil(params.slippage * 10_000)) + 1n;
    if (expected <= 0n || minimum <= 0n || minimum * 10_000n < expected * (10_000n - bps)) {
      throw invalid('the minimum output is below the slippage asked for');
    }
  }
  if (intent.originChainId !== params.originChainId) throw invalid('wrong source chain');
  if (intent.destinationChainId !== params.destinationChainId) {
    throw invalid('wrong destination chain');
  }
  if (!same(intent.originTokenAddress, params.originToken)) throw invalid('wrong source token');
  if (!same(intent.destinationTokenAddress, params.destinationToken)) {
    throw invalid('wrong destination token');
  }
  if (!isAddress(intent.originIntentAddress)) throw invalid('no deposit address');

  const deposit = intent.depositTransaction;
  if (!deposit || deposit.chainId !== params.originChainId)
    throw invalid('deposit on another chain');
  const value = BigInt(deposit.value ?? 0);

  if (same(params.originToken, NATIVE)) {
    // A native deposit is a plain value transfer to the deposit address.
    if (!same(deposit.to, intent.originIntentAddress)) throw invalid('deposit to another address');
    if (value !== params.amount) throw invalid('deposit amount differs from the quote');
    if (deposit.data && deposit.data !== '0x') throw invalid('native deposit carries calldata');
    return;
  }

  if (!same(deposit.to, params.originToken)) throw invalid('deposit is not a call to the token');
  if (value !== 0n) throw invalid('token deposit sends native value');
  if (!isHex(deposit.data)) throw invalid('deposit calldata is not hex');
  let decoded: ReturnType<typeof decodeFunctionData<typeof erc20Abi>>;
  try {
    decoded = decodeFunctionData({ abi: erc20Abi, data: deposit.data });
  } catch {
    throw invalid('deposit is not an ERC-20 call');
  }
  if (decoded.functionName !== 'transfer') throw invalid(`deposit is a ${decoded.functionName}`);
  const [to, amount] = decoded.args;
  if (!same(to, intent.originIntentAddress)) throw invalid('deposit to another address');
  if (amount !== params.amount) throw invalid('deposit amount differs from the quote');
}

import { encodeFunctionData, erc20Abi } from 'viem';
import { describe, expect, it } from 'vitest';

import type { QuotedIntent } from './validate.ts';

import { validateDeposit, validateSavedDeposit } from './validate.ts';

const WALLET = '0xd384ea24ca0B3a5e4BB35935C611E3dCB68Fd08e';
const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const WETH = '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619';
const DEPOSIT = '0x00000000000000000000000000000000000000d0';
const OTHER = '0x1D17C0F90A0b3dFb5124C2FF56B33a0D2E202e1d';
const NATIVE = '0x0000000000000000000000000000000000000000';
const AMOUNT = 1_000_000n;

const transfer = (to: string, amount: bigint) =>
  encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to as `0x${string}`, amount]
  });

function intent(overrides: Record<string, unknown> = {}, deposit: Record<string, unknown> = {}) {
  return {
    intentId: 'intent-1',
    ownerAddress: WALLET,
    originChainId: 137,
    destinationChainId: 137,
    originTokenAddress: USDC,
    destinationTokenAddress: WETH,
    originIntentAddress: DEPOSIT,
    quoteRequest: {
      destinationToAddress: WALLET,
      originTokenAmount: AMOUNT,
      tradeType: 'EXACT_INPUT'
    },
    quote: { toAmount: 1_000_000n, toAmountMin: 995_000n },
    depositTransaction: {
      chainId: 137,
      to: USDC,
      value: 0n,
      data: transfer(DEPOSIT, AMOUNT),
      ...deposit
    },
    ...overrides
  } as unknown as QuotedIntent;
}

const check = (quoted: QuotedIntent, originToken = USDC, amount = AMOUNT) =>
  validateDeposit({
    intent: quoted,
    walletAddress: WALLET,
    originChainId: 137,
    originToken,
    destinationChainId: 137,
    destinationToken: WETH,
    amount,
    slippage: 0.005
  });

const OUT = 400_000_000_000_000n;

// An exact-output quote: AMOUNT of USDC buys exactly OUT of WETH.
const exactOutput = (overrides: Record<string, unknown> = {}) =>
  intent({
    quoteRequest: {
      destinationToAddress: WALLET,
      destinationTokenAmount: OUT,
      tradeType: 'EXACT_OUTPUT'
    },
    quote: { fromAmount: AMOUNT, toAmount: (OUT * 1009n) / 1000n, toAmountMin: OUT },
    ...overrides
  });

const checkExact = (quoted: QuotedIntent) =>
  validateDeposit({
    intent: quoted,
    walletAddress: WALLET,
    originChainId: 137,
    originToken: USDC,
    destinationChainId: 137,
    destinationToken: WETH,
    amount: AMOUNT,
    slippage: 0.005,
    exactOutput: OUT
  });

describe('validateDeposit for an exact-output buy', () => {
  it('accepts a deposit of the quoted input that guarantees the amount asked', () => {
    expect(() => checkExact(exactOutput())).not.toThrow();
  });

  it.each([
    [
      'an exact-input request',
      exactOutput({
        quoteRequest: {
          destinationToAddress: WALLET,
          originTokenAmount: AMOUNT,
          tradeType: 'EXACT_INPUT'
        }
      })
    ],
    [
      'another amount to receive',
      exactOutput({
        quoteRequest: {
          destinationToAddress: WALLET,
          destinationTokenAmount: OUT - 1n,
          tradeType: 'EXACT_OUTPUT'
        }
      })
    ],
    [
      'a minimum below the amount asked',
      exactOutput({ quote: { fromAmount: AMOUNT, toAmount: OUT, toAmountMin: OUT - 1n } })
    ],
    [
      'a deposit other than the quoted input',
      exactOutput({ quote: { fromAmount: AMOUNT - 1n, toAmount: OUT, toAmountMin: OUT } })
    ]
  ])('refuses %s', (_label, quoted) => {
    expect(() => checkExact(quoted)).toThrow(
      expect.objectContaining({ code: 'upstream_invalid_quote' })
    );
  });
});

describe('validateDeposit', () => {
  it('accepts exactly transfer(depositAddress, quotedAmount) on the source token', () => {
    expect(() => check(intent())).not.toThrow();
  });

  it('accepts a native deposit that is a plain value transfer', () => {
    expect(() =>
      check(
        intent({ originTokenAddress: NATIVE }, { to: DEPOSIT, value: AMOUNT, data: '0x' }),
        NATIVE
      )
    ).not.toThrow();
  });

  it.each([
    ['a transfer to another address', intent({}, { data: transfer(OTHER, AMOUNT) })],
    ['a different amount', intent({}, { data: transfer(DEPOSIT, AMOUNT + 1n) })],
    [
      'an approve',
      intent(
        {},
        {
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [DEPOSIT, AMOUNT]
          })
        }
      )
    ],
    ['a call to another contract', intent({}, { to: OTHER })],
    ['native value alongside a token deposit', intent({}, { value: 1n })],
    ['a deposit on another chain', intent({}, { chainId: 8453 })],
    ['arbitrary calldata', intent({}, { data: '0xdeadbeef' })],
    ['another owner', intent({ ownerAddress: OTHER })],
    ['output to another address', intent({ quoteRequest: { destinationToAddress: OTHER } })],
    ['another destination token', intent({ destinationTokenAddress: USDC })],
    ['another source chain', intent({ originChainId: 8453 })],
    ['an unsafe intent id', intent({ intentId: '../../etc/passwd' })],
    [
      'no echoed recipient',
      intent({ quoteRequest: { originTokenAmount: AMOUNT, tradeType: 'EXACT_INPUT' } })
    ],
    [
      'a destination contract call',
      intent({
        quoteRequest: {
          destinationToAddress: WALLET,
          originTokenAmount: AMOUNT,
          destinationCallData: '0xdeadbeef'
        }
      })
    ],
    [
      'another quoted amount',
      intent({ quoteRequest: { destinationToAddress: WALLET, originTokenAmount: AMOUNT * 2n } })
    ],
    ['a minimum output of 0', intent({ quote: { toAmount: 1_000_000n, toAmountMin: 0n } })],
    [
      'a minimum below the slippage',
      intent({ quote: { toAmount: 1_000_000n, toAmountMin: 990_000n } })
    ]
  ])('refuses %s with upstream_invalid_quote', (_label, quoted) => {
    expect(() => check(quoted)).toThrow(
      expect.objectContaining({ code: 'upstream_invalid_quote' })
    );
  });

  it('refuses a native deposit to another address or with calldata', () => {
    for (const deposit of [
      { to: OTHER, value: AMOUNT, data: '0x' },
      { to: DEPOSIT, value: AMOUNT, data: '0xdeadbeef' },
      { to: DEPOSIT, value: AMOUNT - 1n, data: '0x' }
    ]) {
      expect(() => check(intent({ originTokenAddress: NATIVE }, deposit), NATIVE)).toThrow(
        expect.objectContaining({ code: 'upstream_invalid_quote' })
      );
    }
  });
});

describe('validateSavedDeposit', () => {
  const saved = (deposit: { to: string; data: string; value: string }, token = USDC) => ({
    intentId: 'i-1',
    origin: { token, amount: String(AMOUNT) },
    deposit,
    depositAddress: DEPOSIT
  });

  it('passes the quoted transfer, token or native', () => {
    expect(() =>
      validateSavedDeposit(saved({ to: USDC, data: transfer(DEPOSIT, AMOUNT), value: '0' }))
    ).not.toThrow();
    expect(() =>
      validateSavedDeposit(saved({ to: DEPOSIT, data: '0x', value: String(AMOUNT) }, NATIVE))
    ).not.toThrow();
  });

  it.each([
    ['another contract', { to: OTHER, data: transfer(DEPOSIT, AMOUNT), value: '0' }],
    ['native value', { to: USDC, data: transfer(DEPOSIT, AMOUNT), value: '1' }],
    ['another amount', { to: USDC, data: transfer(DEPOSIT, AMOUNT * 2n), value: '0' }],
    [
      'an approve',
      {
        to: USDC,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [OTHER, AMOUNT] }),
        value: '0'
      }
    ],
    ['arbitrary calldata', { to: USDC, data: '0xdeadbeef', value: '0' }],
    ['another recipient', { to: USDC, data: transfer(OTHER, AMOUNT), value: '0' }]
  ])('refuses a saved deposit edited into %s', (_what, deposit) => {
    expect(() => validateSavedDeposit(saved(deposit))).toThrow(/no longer matches its quote/);
  });

  it('refuses a native deposit sent elsewhere', () => {
    expect(() =>
      validateSavedDeposit(saved({ to: OTHER, data: '0x', value: String(AMOUNT) }, NATIVE))
    ).toThrow(/another recipient/);
  });

  it('refuses a native deposit carrying calldata', () => {
    expect(() =>
      validateSavedDeposit(
        saved({ to: DEPOSIT, data: '0xdeadbeef', value: String(AMOUNT) }, NATIVE)
      )
    ).toThrow(/no longer matches its quote/);
  });
});

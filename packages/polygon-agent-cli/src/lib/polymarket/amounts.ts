// USD and share amounts for Polymarket commands. pUSD and USDC use 6 decimals.

import { formatUnits, parseUnits } from 'viem';

import { CliError } from '../errors.ts';

export function parseUsd(input: string | number, field = 'amount'): bigint {
  const text = String(input).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(text)) {
    throw new CliError({
      code: 'invalid_input',
      message: `${field} must be a positive USD amount with at most 6 decimals, got '${input}'.`
    });
  }
  const units = parseUnits(text, 6);
  if (units <= 0n) {
    throw new CliError({ code: 'invalid_input', message: `${field} must be greater than 0.` });
  }
  return units;
}

export function formatUnits6(units: bigint | string): string {
  return formatUnits(BigInt(units), 6);
}

export function parseShares(input: string | number): number | 'all' {
  const text = String(input).trim();
  if (text.toLowerCase() === 'all') return 'all';
  // Plain decimals only: Number() would also take '0x10' or '1e3'.
  const n = /^\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliError({
      code: 'invalid_input',
      message: `shares must be a positive number or 'all', got '${input}'.`
    });
  }
  return n;
}

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { previewSwapCommand } from './command.ts';

// Parse through a real POSIX shell, without running the wallet CLI.
function argumentsOf(command: string, cwd: string): string[] {
  const args = command.replace(/^polygon-agent /, '');
  return execFileSync('sh', ['-c', `set -- ${args}; printf '%s\\0' "$@"`], {
    cwd,
    encoding: 'utf8'
  })
    .split('\0')
    .filter(Boolean);
}

describe('swap preview continuation commands', () => {
  it('preserves a named token address instead of substituting its resolved symbol', () => {
    const from = '0x1234567890123456789012345678901234567890';
    const command = previewSwapCommand({
      request: { walletName: 'main', from, to: 'POL', amount: '1', now: new Date() },
      source: { symbol: 'CUSTOM', chainId: 137 }
    });
    expect(command).toBe(
      `polygon-agent swap --to POL --from ${from} --chain polygon --amount 1 --dry-run`
    );
    expect(command).not.toContain('CUSTOM');
  });

  it.each([
    { amount: '50%', flag: '--amount', value: '50%' },
    { amountUsd: 12.5, flag: '--amount-usd', value: '12.5' },
    { toAmount: '10.00000000', flag: '--to-amount', value: '10.00000000' }
  ])('preserves $flag, destination and limits when changing the source', (amount) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-command-'));
    try {
      const command = previewSwapCommand({
        request: {
          walletName: 'personal',
          to: 'POL',
          ...amount,
          chain: 'base',
          toChain: 'polygon',
          slippage: 0.003,
          now: new Date()
        },
        source: { symbol: 'USDT', chainId: 137 }
      });
      expect(argumentsOf(command, cwd)).toEqual([
        'swap',
        '--wallet',
        'personal',
        '--to',
        'POL',
        '--from',
        'USDT',
        '--chain',
        'polygon',
        '--to-chain',
        'polygon',
        amount.flag,
        amount.value,
        '--slippage',
        '0.003',
        '--dry-run'
      ]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('keeps shell metacharacters literal and never broadcasts', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-command-'));
    try {
      const value = "a'$(touch PWNED)`touch PWNED` $HOME;";
      const command = previewSwapCommand({
        request: { walletName: value, to: value, from: 'USDC', amount: 'all', now: new Date() }
      });
      expect(argumentsOf(command, cwd)).toEqual([
        'swap',
        '--wallet',
        value,
        '--to',
        value,
        '--from',
        'USDC',
        '--amount',
        'all',
        '--dry-run'
      ]);
      expect(fs.existsSync(path.join(cwd, 'PWNED'))).toBe(false);
      expect(command).not.toContain('--broadcast');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it } from 'vitest';

import { vaultUrl } from './vaultUrl.js';

describe('vaultUrl', () => {
  it('points at the vault contract on the Katana explorer', () => {
    expect(vaultUrl('0x1111111111111111111111111111111111111111')).toBe(
      'https://katanascan.com/address/0x1111111111111111111111111111111111111111'
    );
  });
});

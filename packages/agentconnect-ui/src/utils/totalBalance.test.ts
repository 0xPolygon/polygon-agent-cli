import { describe, expect, it } from 'vitest';

import { totalBalance } from './totalBalance.js';

const settled = {
  spend: 0,
  earn: 0,
  predictions: 0,
  predictionsSettled: true,
  vaults: 0,
  vaultsSettled: true
};

describe('totalBalance', () => {
  it('equals the sum of the displayed parts where unrounded addition differs by a cent', () => {
    // Shown as 10.00 + 10.00; adding the raw 10.004s first would give 20.01.
    expect(totalBalance({ ...settled, spend: 10.004, earn: 10.004 })).toBe(20);
  });

  it('is unknown while any part is still loading', () => {
    expect(totalBalance({ ...settled, spend: null })).toBeNull();
    expect(totalBalance({ ...settled, earn: null })).toBeNull();
    expect(totalBalance({ ...settled, predictions: null, predictionsSettled: false })).toBeNull();
    expect(totalBalance({ ...settled, vaults: null, vaultsSettled: false })).toBeNull();
  });

  it('is unknown while predictions are unsettled, even with a provisional figure', () => {
    expect(totalBalance({ ...settled, predictions: 50, predictionsSettled: false })).toBeNull();
  });

  it('settles when predictions or vaults failed or do not exist', () => {
    expect(totalBalance({ ...settled, spend: 5, predictions: null, vaults: null })).toBe(5);
  });

  it('is zero for an empty wallet', () => {
    expect(totalBalance(settled)).toBe(0);
  });
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { Holding } from '../../indexer';

import { sum } from '../../utils/holdings.js';
import { totalBalance } from '../../utils/totalBalance.js';
import { OverviewTab } from './OverviewTab.js';

const holding = (usd: number): Holding => ({
  chainId: 137,
  address: '0x1111111111111111111111111111111111111111',
  symbol: 'USDC',
  name: 'USD Coin',
  qty: usd,
  usd,
  kind: 'spend'
});

describe('OverviewTab', () => {
  it.each([
    [1.005, '$1.00', '$1.01'],
    [0.145, '$0.14', '$0.15']
  ])('prints the spend line the same as the headline for %s', (usd, figure, wrong) => {
    const holdings = { data: [holding(usd)], loading: false, error: false };
    const headline = totalBalance({
      spend: sum(holdings.data, 'spend'),
      earn: 0,
      predictions: 0,
      predictionsSettled: true,
      vaults: 0,
      vaultsSettled: true
    });
    const noop = () => undefined;
    const html = renderToStaticMarkup(
      createElement(OverviewTab, {
        holdings,
        totalBalance: headline,
        positionsValue: 0,
        vaultsValue: 0,
        earningApy: null,
        go: noop,
        onAdd: noop,
        onWithdraw: noop,
        onReceive: noop,
        onTryAgent: noop
      })
    );
    expect(html).not.toContain(wrong);
    // Once in the headline, once in the spend line.
    expect(html.split(`>${figure}<`).length - 1).toBe(2);
  });
});

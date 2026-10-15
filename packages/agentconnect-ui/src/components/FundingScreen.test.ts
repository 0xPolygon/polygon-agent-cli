import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ props: undefined as Record<string, unknown> | undefined }));
vi.mock('0xtrails/widget', () => ({
  Fund: (props: Record<string, unknown>) => {
    seen.props = props;
    return null;
  }
}));

import { FundingScreen, parseFundAmount } from './FundingScreen';

const render = (amount?: string) => {
  seen.props = undefined;
  renderToStaticMarkup(
    createElement(FundingScreen, {
      walletAddress: '0xabc',
      chainId: 137,
      amount,
      onSkip: () => {}
    })
  );
  return seen.props;
};

describe('FundingScreen amount', () => {
  it('targets the amount in USDC on Polygon', () => {
    expect(render('5')).toMatchObject({
      toAmount: '5',
      to: { recipient: '0xabc', token: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', chain: 137 }
    });
  });

  it('sets no amount without one', () => {
    expect(render()).not.toHaveProperty('toAmount');
  });
});

describe('parseFundAmount', () => {
  it('keeps positive decimals only', () => {
    expect(parseFundAmount('5')).toBe('5');
    expect(parseFundAmount('2.5')).toBe('2.5');
    expect(parseFundAmount('0')).toBeUndefined();
    expect(parseFundAmount('-1')).toBeUndefined();
    expect(parseFundAmount('abc')).toBeUndefined();
    expect(parseFundAmount(null)).toBeUndefined();
  });
});

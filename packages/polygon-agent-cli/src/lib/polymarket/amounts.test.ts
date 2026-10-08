import { describe, expect, it } from 'vitest';

import { formatUnits6, parseShares, parseUsd } from './amounts.ts';

describe('parseUsd', () => {
  it('parses whole and fractional dollars into 6-decimal units', () => {
    expect(parseUsd('10')).toBe(10_000_000n);
    expect(parseUsd('10.5')).toBe(10_500_000n);
    expect(parseUsd(0.000001)).toBe(1n);
  });

  it.each(['0', '-1', 'abc', '', '1.0000001', 'NaN', 'Infinity'])('rejects %s', (bad) => {
    expect(() => parseUsd(bad)).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });
});

describe('formatUnits6', () => {
  it('formats base units as a decimal string', () => {
    expect(formatUnits6(10_500_000n)).toBe('10.5');
    expect(formatUnits6('1')).toBe('0.000001');
  });
});

describe('parseShares', () => {
  it('accepts a positive number or all', () => {
    expect(parseShares('12.5')).toBe(12.5);
    expect(parseShares('all')).toBe('all');
    expect(parseShares('ALL')).toBe('all');
  });

  it.each(['0', '-3', 'x'])('rejects %s', (bad) => {
    expect(() => parseShares(bad)).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });
});

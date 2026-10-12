import { describe, expect, it } from 'vitest';

import {
  addressFromMetadata,
  addressToMetadata,
  parseAddress,
  ValidationError
} from './shipping.ts';

const ADDRESS = {
  name: 'A',
  line1: '1 Main',
  line2: '',
  city: 'X',
  state: '',
  zip: '',
  country: 'US',
  phone: ''
};

describe('parseAddress', () => {
  it('trims and fills optional fields', () => {
    expect(parseAddress({ name: ' A ', line1: '1 Main', city: 'X', country: 'US' })).toEqual(
      ADDRESS
    );
  });

  it('requires name, street, city, and country', () => {
    expect(() => parseAddress({ ...ADDRESS, city: ' ' })).toThrow(ValidationError);
  });

  it('rejects non-strings and long values', () => {
    expect(() => parseAddress({ ...ADDRESS, zip: 11217 })).toThrow(/string/);
    expect(() => parseAddress({ ...ADDRESS, line1: 'x'.repeat(201) })).toThrow(/too long/);
  });
});

describe('metadata', () => {
  it('round-trips', () => {
    expect(addressFromMetadata(addressToMetadata(ADDRESS))).toEqual(ADDRESS);
  });

  it('clears every field', () => {
    const cleared = addressToMetadata(null);
    expect(Object.values(cleared).every((v) => v === '')).toBe(true);
    expect(addressFromMetadata(cleared)).toBeNull();
  });
});

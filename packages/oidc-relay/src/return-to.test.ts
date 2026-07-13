import { describe, expect, it } from 'vitest';

import { validReturnTo } from './return-to.ts';

describe('validReturnTo', () => {
  it('accepts the production and staging login pages over https', () => {
    expect(validReturnTo('https://agentconnect.polygon.technology/login#abc')).toBe(true);
    expect(validReturnTo('https://agentconnect.staging.polygon.technology/login#abc')).toBe(true);
  });
  it('accepts localhost over http for local dev', () => {
    expect(validReturnTo('http://localhost:5173/login#abc')).toBe(true);
    expect(validReturnTo('http://127.0.0.1:5173/login#abc')).toBe(true);
  });
  it('rejects http on non-local hosts', () => {
    expect(validReturnTo('http://agentconnect.polygon.technology/login')).toBe(false);
  });
  it('rejects other hosts', () => {
    expect(validReturnTo('https://evil.example.com/login')).toBe(false);
    expect(validReturnTo('https://agentconnect.polygon.technology.evil.com/login')).toBe(false);
  });
  it('rejects non-URLs, non-strings, and oversized values', () => {
    expect(validReturnTo('not a url')).toBe(false);
    expect(validReturnTo(42)).toBe(false);
    expect(validReturnTo(`https://agentconnect.polygon.technology/${'a'.repeat(2050)}`)).toBe(
      false
    );
  });
});

import { describe, expect, it } from 'vitest';

import { getSessionId, isRelayReturn } from './returnUrl.ts';

describe('getSessionId', () => {
  it('reads the session from the query string', () => {
    expect(getSessionId('?s=abc', '')).toBe('abc');
  });

  it('falls back to the fragment when there is no query', () => {
    expect(getSessionId('', '#abc')).toBe('abc');
  });

  it('prefers the query over the fragment when both are present', () => {
    expect(getSessionId('?s=abc', '#xyz')).toBe('abc');
  });

  it('returns an empty string when neither is present', () => {
    expect(getSessionId('', '')).toBe('');
  });
});

describe('isRelayReturn', () => {
  it('is false for a fragment-only announce link (no query at all)', () => {
    expect(isRelayReturn('#abc')).toBe(false);
  });

  it('is true for a bare oauth callback param, no `s` needed', () => {
    expect(isRelayReturn('?code=xyz')).toBe(true);
  });

  it('is true when `s` and an oauth callback param are both present', () => {
    expect(isRelayReturn('?s=abc&code=xyz')).toBe(true);
  });

  it('is true for a bare `state` param', () => {
    expect(isRelayReturn('?state=1')).toBe(true);
  });

  it('is true when the relay reports an oauth error', () => {
    expect(isRelayReturn('?error=access_denied')).toBe(true);
  });

  it('is false for `s` alongside a non-oauth query param', () => {
    expect(isRelayReturn('?s=abc&utm_source=x')).toBe(false);
  });

  it('is false for a non-oauth query param with no `s`', () => {
    expect(isRelayReturn('?utm_source=x')).toBe(false);
  });

  it('is false for an empty query string', () => {
    expect(isRelayReturn('')).toBe(false);
  });
});

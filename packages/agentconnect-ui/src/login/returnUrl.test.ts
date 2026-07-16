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

  it('is false for a bare `s` with no other query keys', () => {
    expect(isRelayReturn('?s=abc')).toBe(false);
  });

  it('is true once a relay callback param joins `s`', () => {
    expect(isRelayReturn('?s=abc&code=xyz')).toBe(true);
  });

  it('is true with multiple relay callback params alongside `s`', () => {
    expect(isRelayReturn('?s=abc&state=1&code=2')).toBe(true);
  });

  it('is true when the relay reports an oauth error', () => {
    expect(isRelayReturn('?s=abc&error=access_denied')).toBe(true);
  });

  it('is false when a link wrapper appends utm params to a pasted link', () => {
    expect(isRelayReturn('?s=abc&utm_source=x')).toBe(false);
  });

  it('is false when a link wrapper appends a gclid param to a pasted link', () => {
    expect(isRelayReturn('?s=abc&gclid=x')).toBe(false);
  });

  it('is false when `s` is missing, even with other query keys', () => {
    expect(isRelayReturn('?code=xyz')).toBe(false);
  });

  it('is false for an empty query string', () => {
    expect(isRelayReturn('')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { validAction, validCallbackUrl } from './relay.ts';

describe('validCallbackUrl', () => {
  it('accepts the production and staging agentconnect login pages over https', () => {
    expect(validCallbackUrl('https://agentconnect.polygon.technology/login#abc')).toBe(true);
    expect(validCallbackUrl('https://agentconnect.staging.polygon.technology/login#abc')).toBe(
      true
    );
  });

  it('accepts localhost over http for local dev', () => {
    expect(validCallbackUrl('http://localhost:5173/login#abc')).toBe(true);
  });

  it('rejects a lookalike host that merely starts with localhost', () => {
    expect(validCallbackUrl('http://localhost.evil.example/x')).toBe(false);
  });

  it('rejects a numeric prefix collision with 127.0.0.1', () => {
    expect(validCallbackUrl('http://127.0.0.100/x')).toBe(false);
  });

  it('rejects a non-URL string', () => {
    expect(validCallbackUrl('not a url')).toBe(false);
  });

  it('rejects an https URL on a non-allowlisted host', () => {
    expect(validCallbackUrl('https://evil.example/login')).toBe(false);
  });

  it('rejects a URL longer than 2048 characters', () => {
    expect(validCallbackUrl(`https://agentconnect.polygon.technology/${'a'.repeat(2050)}`)).toBe(
      false
    );
  });
});

describe('validAction', () => {
  it('accepts an oidc-callback action with a good callback URL', () => {
    expect(
      validAction({
        type: 'oidc-callback',
        callbackUrl: 'https://agentconnect.polygon.technology/login#abc'
      })
    ).toBe(true);
  });

  it('rejects an oidc-callback action with a bad callback URL', () => {
    expect(
      validAction({
        type: 'oidc-callback',
        callbackUrl: 'https://evil.example/login'
      })
    ).toBe(false);
  });
});

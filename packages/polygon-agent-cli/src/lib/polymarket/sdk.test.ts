import { describe, expect, it } from 'vitest';

import { CliError } from '../errors.ts';
import { loadSdk, mapSdkError } from './sdk.ts';

describe('loadSdk', () => {
  it('lazily loads the SDK root and subpaths', async () => {
    const sdk = await loadSdk();
    expect(typeof sdk.root.createSecureClient).toBe('function');
    expect(typeof sdk.viem.privateKey).toBe('function');
    expect(typeof sdk.node.builderApiKey).toBe('function');
    expect(typeof sdk.actions.createBuilderApiKey).toBe('function');
  });
});

describe('mapSdkError', () => {
  it('maps a 429 to rate_limited', async () => {
    const { root } = await loadSdk();
    const err = new root.RateLimitError('slow down');
    const mapped = mapSdkError(err) as CliError;
    expect(mapped).toBeInstanceOf(CliError);
    expect(mapped.code).toBe('rate_limited');
  });

  it('maps a transport failure to upstream_unavailable', async () => {
    const { root } = await loadSdk();
    const mapped = mapSdkError(new root.TransportError('boom')) as CliError;
    expect(mapped.code).toBe('upstream_unavailable');
  });

  it('maps a UserInputError to invalid_input and keeps the message', async () => {
    const { root } = await loadSdk();
    const mapped = mapSdkError(new root.UserInputError('amount: too small')) as CliError;
    expect(mapped.code).toBe('invalid_input');
    expect(mapped.message).toMatch(/amount: too small/);
  });

  it('passes through errors it does not know', () => {
    const err = new Error('other');
    expect(mapSdkError(err)).toBe(err);
  });
});

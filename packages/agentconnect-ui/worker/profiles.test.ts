import { describe, expect, it } from 'vitest';

import { policyOf, profileForClient, PROFILES } from './profiles.ts';

describe('client profiles', () => {
  it('maps a configured client id to its profile', () => {
    expect(profileForClient('{"cli_muse":"muse"}', 'cli_muse')).toBe('muse');
  });

  it('treats every other client as standard', () => {
    expect(profileForClient('{"cli_muse":"muse"}', 'cli_other')).toBe('standard');
    expect(profileForClient(undefined, 'cli_muse')).toBe('standard');
  });

  it('ignores unknown profiles and bad config', () => {
    expect(profileForClient('{"cli_1":"admin"}', 'cli_1')).toBe('standard');
    expect(profileForClient('not json', 'cli_1')).toBe('standard');
  });

  it('gives a client that returns to ChatGPT the OpenAI profile', () => {
    expect(
      profileForClient(undefined, 'cli_1', [
        'https://chatgpt.com/connector_platform_oauth_redirect'
      ])
    ).toBe('openai');
    expect(profileForClient(undefined, 'cli_1', ['https://chat.openai.com/aip/callback'])).toBe(
      'openai'
    );
    // Only the real host counts.
    expect(profileForClient(undefined, 'cli_1', ['https://chatgpt.com.evil.test/cb'])).toBe(
      'standard'
    );
    expect(profileForClient(undefined, 'cli_1', ['http://chatgpt.com/cb'])).toBe('standard');
  });

  it('lets configuration name a ChatGPT client explicitly', () => {
    expect(profileForClient('{"cli_1":"muse"}', 'cli_1', ['https://chatgpt.com/cb'])).toBe('muse');
  });

  it('gives connections from before profiles the standard policy', () => {
    expect(policyOf(undefined)).toBe(PROFILES.standard);
    expect(policyOf('nope')).toBe(PROFILES.standard);
  });

  it('keeps ChatGPT and Muse to reading the wallet', () => {
    expect(PROFILES.openai).toEqual({ tools: ['get_wallet'], movesMoney: false });
    expect(PROFILES.muse).toEqual({ tools: ['get_wallet'], movesMoney: false });
  });

  it('gives standard clients every tool and an allowance', () => {
    expect(PROFILES.standard.movesMoney).toBe(true);
    expect(PROFILES.standard.tools).toEqual([
      'get_wallet',
      'get_allowance',
      'send',
      'swap_quote',
      'swap',
      'swap_status'
    ]);
  });
});

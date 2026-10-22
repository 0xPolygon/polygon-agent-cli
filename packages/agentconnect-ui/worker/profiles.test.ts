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

  it('gives connections from before profiles the standard policy', () => {
    expect(policyOf(undefined)).toBe(PROFILES.standard);
    expect(policyOf('nope')).toBe(PROFILES.standard);
  });

  it('gives Muse only the wallet and address tools', () => {
    expect(PROFILES.muse.tools).toEqual([
      'get_wallet',
      'get_shipping_address',
      'save_shipping_address'
    ]);
  });
});

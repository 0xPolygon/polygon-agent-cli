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

  it('has the owner approve each ChatGPT spend, with bundles, and buying in our browser', () => {
    expect(PROFILES.openai).toMatchObject({ movesMoney: true, ownerApproves: true });
    const tools = PROFILES.standard.tools;
    const money = tools.slice(tools.indexOf('get_allowance'));
    const browser = tools.slice(
      tools.indexOf('start_browser_checkout'),
      tools.indexOf('get_allowance')
    );
    expect(PROFILES.openai.tools).toEqual([
      'get_wallet',
      'get_shipping_address',
      'save_shipping_address',
      'list_cards',
      'add_card',
      'check_card',
      ...browser,
      ...money,
      'propose_bundle'
    ]);
    expect(PROFILES.openai.tools).not.toContain('buy');
  });

  it('lets Muse spend like a standard client but confirm each purchase', () => {
    expect(PROFILES.muse).toMatchObject({ movesMoney: true, ownerApproves: false });
    expect(PROFILES.muse.confirmEachPurchase).toBe(true);
    expect(PROFILES.muse.tools).toContain('confirm_purchase');
    expect(PROFILES.muse.tools).toContain('send');
    expect(PROFILES.muse.tools).not.toContain('start_browser_checkout');
    expect(PROFILES.standard.tools).not.toContain('confirm_purchase');
  });

  it('gives standard clients every tool and an allowance, and one way to buy', () => {
    expect(PROFILES.standard).toMatchObject({ movesMoney: true, ownerApproves: false });
    expect(PROFILES.standard.tools).toEqual([
      'get_wallet',
      'get_shipping_address',
      'save_shipping_address',
      'list_cards',
      'add_card',
      'check_card',
      'start_browser_checkout',
      'browser_look',
      'browser_click',
      'browser_type',
      'browser_select',
      'browser_press',
      'browser_scroll',
      'browser_open',
      'pay_browser_checkout',
      'browser_checkout_status',
      'cancel_browser_checkout',
      'get_allowance',
      'send',
      'swap_quote',
      'swap',
      'swap_status',
      'pay_service',
      'earn_vaults',
      'earn_deposit',
      'earn_withdraw',
      'polymarket_markets',
      'polymarket_account',
      'polymarket_deposit',
      'polymarket_buy',
      'polymarket_sell',
      'polymarket_cancel',
      'polymarket_redeem',
      'polymarket_withdraw',
      'get_action'
    ]);
  });
});

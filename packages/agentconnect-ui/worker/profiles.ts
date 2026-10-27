// What each MCP client may do. A connection gets its profile when the owner
// allows it, from the OAuth client it came from, and keeps it for its life.
//
// `standard` is every client we haven't set up: everything the agent wallet
// does, within the allowance the owner approves when connecting, and buying
// with the saved address and cards (at once under the owner's auto-pay limit).
// ChatGPT (`openai`) gets the money tools, but its apps may not move money
// themselves: each spend, Polymarket included, waits for the owner to approve
// it on this site (money/actions.ts). It has no shopping tools yet.
// Muse spends within the allowance like a standard client, but asks the user
// before every purchase: buy returns a quote, and only confirm_purchase pays.
// ChatGPT is recognised by its redirect URI (it registers a new client per
// install); others are mapped by client id in MCP_CLIENT_PROFILES.

export type Profile = 'standard' | 'openai' | 'muse';

export interface ProfilePolicy {
  // Tools the client sees and may call. An allowlist: a new tool reaches a
  // restricted client only when someone adds it here.
  tools: readonly string[];
  // Whether connecting asks the owner for an allowance to spend from.
  movesMoney: boolean;
  // Whether each spend waits for the owner's approval on the site.
  ownerApproves: boolean;
  // buy returns a quote; only confirm_purchase pays, for the quoted total.
  confirmEachPurchase: boolean;
}

const READ = ['get_wallet'] as const;
// Buying with the saved address and cards.
const SHOP = [
  'get_shipping_address',
  'save_shipping_address',
  'list_cards',
  'add_card',
  'check_card',
  'buy'
] as const;
// Paying at a store's checkout in the agent's own browser, with a one-time card.
const CHECKOUT = ['authorize_checkout', 'get_checkout_card', 'close_checkout'] as const;
const MONEY = [
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
] as const;

// Only where the owner approves each spend: several approved at once.
const BUNDLE = ['propose_bundle'] as const;

export const PROFILES: Record<Profile, ProfilePolicy> = {
  standard: {
    tools: [...READ, ...SHOP, ...CHECKOUT, 'payment_status', ...MONEY],
    movesMoney: true,
    ownerApproves: false,
    confirmEachPurchase: false
  },
  openai: {
    tools: [...READ, ...MONEY, ...BUNDLE],
    movesMoney: true,
    ownerApproves: true,
    confirmEachPurchase: false
  },
  muse: {
    tools: [...READ, ...SHOP, 'confirm_purchase', 'payment_status', ...MONEY],
    movesMoney: true,
    ownerApproves: false,
    confirmEachPurchase: true
  }
};

const isProfile = (v: unknown): v is Profile => typeof v === 'string' && Object.hasOwn(PROFILES, v);

// Where ChatGPT sends its users back after connecting an app.
const OPENAI_REDIRECT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com', 'platform.openai.com']);

function isOpenAiRedirect(uri: string): boolean {
  try {
    const { protocol, hostname } = new URL(uri);
    return protocol === 'https:' && OPENAI_REDIRECT_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

/**
 * The profile for an OAuth client: MCP_CLIENT_PROFILES first (JSON, client id
 * to profile), keyed by client id, never by the name a client registers with,
 * since anyone can register under any name. Then the redirect URIs: a client
 * that returns to ChatGPT gets ChatGPT's rules. A redirect URI only narrows
 * what a client gets, so claiming one gains nothing.
 */
export function profileForClient(
  config: string | undefined,
  clientId: string,
  redirectUris: readonly string[] = []
): Profile {
  if (config) {
    try {
      const map = JSON.parse(config) as Record<string, unknown>;
      const profile = Object.hasOwn(map, clientId) ? map[clientId] : undefined;
      if (isProfile(profile)) return profile;
    } catch {
      console.error('[profiles] MCP_CLIENT_PROFILES is not valid JSON');
    }
  }
  if (redirectUris.some(isOpenAiRedirect)) return 'openai';
  return 'standard';
}

/**
 * A connection's policy. Connections made before profiles existed are
 * standard; without a key they can't spend, and their money tools say to
 * connect again.
 */
export const policyOf = (profile: unknown): ProfilePolicy =>
  PROFILES[isProfile(profile) ? profile : 'standard'];

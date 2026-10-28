// AgentCard vault: cards are saved on AgentCard's hosted page behind the
// user's passkey. We only ever see display fields (brand, last 4, expiry);
// each purchase is approved by the user on their own device.

export interface AgentCardConfig {
  clientId: string;
  clientSecret: string;
  // Ask owners for app auto-approval on add-a-card links (production only).
  autoApproval?: boolean;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface VaultSession {
  id: string;
  url?: string;
  status?: 'pending' | 'linked' | 'expired';
  user_id: string | null;
  expires_at: string;
  poll_interval?: number;
  // Set once the card itself is stored (after the passkey step).
  card?: boolean;
  card_id?: string | null;
}

export interface VaultCard {
  id: string;
  brand: string;
  last4: string;
  expiry_month: number;
  expiry_year: number;
  created_at: string;
}

// A connection: tokens that act as one vault user, for the Purchase API.
export interface Connection {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  user?: { id: string };
}

export interface BuyCart {
  merchant: string;
  merchant_name?: string;
  items: { name: string; qty: number; priceCents: number; product_id?: string }[];
  serviceFeesCents?: number;
  tipCents?: number;
  totalCents: number;
  hash: string;
}

// One turn of a /buy conversation. Branch on `status`, never on `reply`.
export interface BuyTurn {
  conversation_id: string;
  status: 'needs_input' | 'order_placed' | 'partially_placed' | 'declined' | string;
  reply?: string;
  cart?: BuyCart | null;
  carts?: BuyCart[];
  unmatched?: { name?: string; reason?: string }[];
  catalog?: {
    merchant_name?: string;
    items?: { id: string; name: string; priceCents?: number; image_url?: string }[];
  } | null;
  decline_code?: string | null;
  approval_url?: string | null;
  charge_status?: string | null;
  order_id?: string | null;
  payment_source?: { source: string; brand?: string; last4?: string } | null;
}

// The server's view of a purchase conversation (for a confirm that is still running).
export interface BuyConversation {
  turn_in_progress?: boolean;
  last_checkout?: {
    status?: string;
    order_id?: string | null;
    decline_code?: string | null;
    approval_url?: string | null;
    charge_status?: string;
  } | null;
  orders?: { order_id: string; merchant?: string; status?: string }[];
}

export interface BuyRequest {
  ask?: string;
  conversation_id?: string;
  confirm?: string;
  payment_source?: 'vault';
  delivery_address?: {
    street: string;
    address2?: string;
    city: string;
    state: string;
    zip: string;
    phone?: string;
    name?: string;
    country?: string;
  };
}

// A one-time card drawn on the member's own added card, for checkouts the
// agent fills in itself. `credentials` only come on an open card: never store them.
export interface MemberCard {
  id: string;
  status: 'approval_pending' | 'open' | 'in_use' | 'paused' | 'pausing' | 'closing' | 'closed';
  spend_limit_cents?: number;
  last4?: string;
  expiry?: string;
  approval_url?: string;
  expires_at?: string;
  closed_reason?: 'used' | 'canceled' | 'expired' | 'declined' | string;
  credentials?: {
    number: string;
    exp_month: number | null;
    exp_year: number | null;
    cvc: string;
  } | null;
  credentials_status?: 'protected' | 'retry' | string;
}

// What happens next for a member: add their card, create one, or approve.
export interface FlowStatus {
  status:
    | 'no_card_attached'
    | 'attach_pending'
    | 'attach_failed'
    | 'ready'
    | 'approval_pending'
    | 'card_ready';
  next_action?: {
    type: 'attach_card' | 'create_card' | 'share_approval_url' | 'get_card';
    id?: string;
    url?: string;
    expires_at?: string;
  } | null;
  attached_cards?: {
    id: string;
    status: 'pending' | 'active' | 'ineligible' | 'revoked';
    network?: string | null;
    brand?: string | null;
    last4?: string | null;
  }[];
  reason?: string;
  message?: string;
}

export class AgentCardError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

// What to tell the owner or agent when a card call fails. Request problems they can fix get a
// specific message; anything else reads as an outage.
export function agentCardFailure(err: AgentCardError): {
  status: number;
  code: string;
  message: string;
} {
  if (err.code === 'invalid_delivery_address')
    return {
      status: 400,
      code: err.code,
      message:
        'The store cannot deliver to the saved shipping address. Save a US address and try again.'
    };
  if (err.code === 'subscription_required')
    return {
      status: 503,
      code: 'cards_unavailable',
      message: 'Paying at other stores is not switched on for this deployment yet.'
    };
  if (err.code === 'byoc_unavailable')
    return {
      status: 503,
      code: 'card_network_unavailable',
      message: 'The card network is briefly unavailable. Try again in a minute.'
    };
  if (err.status === 429)
    return {
      status: 429,
      code: 'rate_limited',
      message: 'Too many card requests. Try again in a minute.'
    };
  return {
    status: 502,
    code: 'upstream_error',
    message: 'The card service is unavailable. Try again shortly.'
  };
}

// The token endpoint allows 30 requests per 5 minutes per IP: reuse tokens.
let tokenCache: { key: string; token: string; expiresAt: number } | null = null;

export function resetAgentCardTokenCache(): void {
  tokenCache = null;
}

export class AgentCard {
  private readonly base: string;
  private readonly f: typeof fetch;

  constructor(private readonly cfg: AgentCardConfig) {
    this.base = (cfg.apiUrl ?? 'https://api.agentcard.sh').replace(/\/+$/, '');
    // Unbound: Workers throw "Illegal invocation" when fetch is called as a method.
    this.f = cfg.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private async token(): Promise<string> {
    const now = Date.now();
    if (tokenCache && tokenCache.key === this.cfg.clientId && tokenCache.expiresAt - 60_000 > now) {
      return tokenCache.token;
    }
    const res = await this.f(`${this.base}/api/v2/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret
      }).toString()
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      throw new AgentCardError(
        res.status,
        body.error ?? 'auth_failed',
        `AgentCard auth failed: ${body.error_description ?? res.status}`
      );
    }
    tokenCache = {
      key: this.cfg.clientId,
      token: body.access_token,
      expiresAt: now + (body.expires_in ?? 3600) * 1000
    };
    return body.access_token;
  }

  // `asUser` sends a user's connection token instead of the platform token.
  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    asUser?: string,
    headers: Record<string, string> = {}
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.f(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${asUser ?? (await this.token())}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if (res.status === 401 && attempt === 0 && !asUser) {
        tokenCache = null;
        continue;
      }
      const data = (await res.json().catch(() => ({}))) as T & {
        error?: { code?: string; message?: string } | string;
      };
      if (!res.ok) {
        const err = typeof data.error === 'object' ? data.error : { code: data.error };
        throw new AgentCardError(
          res.status,
          err?.code ?? 'agentcard_error',
          `AgentCard ${method} ${path} failed: ${err?.message ?? res.status}`
        );
      }
      return data;
    }
  }

  /**
   * A single-use add-a-card link. With a known user it signs them in with a code
   * first. `externalUserId` (our wallet address) ties the AgentCard user to the
   * wallet on AgentCard's side too.
   */
  createVaultSession(
    userId?: string | null,
    opts: { autoApproval?: boolean; externalUserId?: string } = {}
  ): Promise<VaultSession> {
    const autoApproval = opts.autoApproval ?? this.cfg.autoApproval;
    return this.call<VaultSession>('POST', '/api/v2/vault_sessions', {
      ...(userId ? { user_id: userId } : {}),
      ...(opts.externalUserId ? { external_user_id: opts.externalUserId } : {}),
      // Asks the owner, on the vault page, to let us pay with this card without
      // an approval link each time (production credentials only).
      ...(autoApproval ? { approval_mode: 'partner' } : {})
    });
  }

  getVaultSession(id: string): Promise<VaultSession> {
    return this.call<VaultSession>('GET', `/api/v2/vault_sessions/${encodeURIComponent(id)}`);
  }

  async listCards(userId: string): Promise<VaultCard[]> {
    try {
      const res = await this.call<{ data?: VaultCard[] }>(
        'GET',
        `/api/v2/vault_cards?${new URLSearchParams({ user_id: userId })}`
      );
      return res.data ?? [];
    } catch (err) {
      // A user from the other mode (sandbox vs live), or one who never finished.
      if (err instanceof AgentCardError && err.status === 404) return [];
      throw err;
    }
  }

  /**
   * Turn a linked add-a-card session into the user's connection tokens. Single
   * use: a second call is refused with 410 already_exchanged.
   */
  exchangeVaultSession(id: string): Promise<Connection> {
    return this.call<Connection>(
      'POST',
      `/api/v2/vault_sessions/${encodeURIComponent(id)}/exchange`
    );
  }

  /** A fresh token pair. The old refresh token stops working. */
  refreshConnection(refreshToken: string): Promise<Connection> {
    return this.call<Connection>('POST', '/api/v2/connect/refresh', {
      refresh_token: refreshToken
    });
  }

  /** One turn of the Purchase API, as the user. Money only moves on a confirm. */
  buy(userToken: string, body: BuyRequest): Promise<BuyTurn> {
    return this.call<BuyTurn>('POST', '/buy', body, userToken);
  }

  buyConversation(userToken: string, id: string): Promise<BuyConversation> {
    return this.call<BuyConversation>(
      'GET',
      `/buy/conversations/${encodeURIComponent(id)}`,
      undefined,
      userToken
    );
  }

  flowStatus(userToken: string): Promise<FlowStatus> {
    return this.call<FlowStatus>('GET', '/api/v2/flow_status', undefined, userToken);
  }

  /**
   * A one-time card for exactly `amount_cents`, drawn on the member's added
   * card. The same `key` always resumes the same card, never a second one.
   */
  createCard(
    userToken: string,
    key: string,
    body: {
      amount_cents: number;
      merchant?: { name: string; url?: string };
      description?: string;
    }
  ): Promise<MemberCard> {
    return this.call<MemberCard>('POST', '/api/v2/cards', { currency: 'usd', ...body }, userToken, {
      'Idempotency-Key': key
    });
  }

  /** The card's state. Reading an open card notifies the member, so read it once. */
  getCard(userToken: string, id: string): Promise<MemberCard> {
    return this.call<MemberCard>(
      'GET',
      `/api/v2/cards/${encodeURIComponent(id)}`,
      undefined,
      userToken
    );
  }

  /** Close a card early. Closing a closed card is fine. */
  closeCard(userToken: string, id: string): Promise<{ id: string; status: string }> {
    return this.call<{ id: string; status: string }>(
      'POST',
      `/api/v2/cards/${encodeURIComponent(id)}/close`,
      undefined,
      userToken
    );
  }
}

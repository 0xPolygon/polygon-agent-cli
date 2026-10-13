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

export class AgentCardError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
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
  private async call<T>(method: string, path: string, body?: unknown, asUser?: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.f(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${asUser ?? (await this.token())}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
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

  /** A single-use add-a-card link. With a known user it signs them in with a code first. */
  createVaultSession(
    userId?: string | null,
    opts: { autoApproval?: boolean } = { autoApproval: this.cfg.autoApproval }
  ): Promise<VaultSession> {
    return this.call<VaultSession>('POST', '/api/v2/vault_sessions', {
      ...(userId ? { user_id: userId } : {}),
      // Asks the owner, on the vault page, to let us pay with this card without
      // an approval link each time (production credentials only).
      ...(opts.autoApproval ? { approval_mode: 'partner' } : {})
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
}

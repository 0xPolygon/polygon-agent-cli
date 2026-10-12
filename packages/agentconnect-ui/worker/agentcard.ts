// AgentCard vault: cards are saved on AgentCard's hosted page behind the
// user's passkey. We only ever see display fields (brand, last 4, expiry);
// each purchase is approved by the user on their own device.

export interface AgentCardConfig {
  clientId: string;
  clientSecret: string;
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

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.f(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if (res.status === 401 && attempt === 0) {
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
  createVaultSession(userId?: string | null): Promise<VaultSession> {
    return this.call<VaultSession>(
      'POST',
      '/api/v2/vault_sessions',
      userId ? { user_id: userId } : {}
    );
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
}

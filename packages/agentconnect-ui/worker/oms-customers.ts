// OMS customers API: one customer per agent wallet (externalId = lowercase
// wallet address), holding the shipping address in metadata.

export interface OmsConfig {
  apiUrl: string;
  apiKey: string;
  apiSecret: string;
  fetchImpl?: typeof fetch;
}

export interface Customer {
  id: string;
  externalId?: string | null;
  email?: string | null;
  status?: string;
  metadata?: Record<string, string> | null;
}

export class OmsError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

// Tokens last an hour; reuse one per isolate until shortly before it expires.
let tokenCache: { key: string; token: string; expiresAt: number } | null = null;

export function resetOmsTokenCache(): void {
  tokenCache = null;
}

export class OmsCustomers {
  private readonly base: string;
  private readonly f: typeof fetch;

  constructor(private readonly cfg: OmsConfig) {
    this.base = cfg.apiUrl.replace(/\/+$/, '');
    // Unbound: Workers throw "Illegal invocation" when fetch is called as a method.
    this.f = cfg.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private async token(): Promise<string> {
    const now = Date.now();
    if (tokenCache && tokenCache.key === this.cfg.apiKey && tokenCache.expiresAt - 60_000 > now) {
      return tokenCache.token;
    }
    const res = await this.f(`${this.base}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: this.cfg.apiKey, apiSecret: this.cfg.apiSecret })
    });
    const body = (await res.json().catch(() => ({}))) as {
      accessToken?: string;
      expiresIn?: number;
      error?: string;
      msg?: string;
    };
    if (!res.ok || !body.accessToken) {
      throw new OmsError(
        res.status,
        body.error ?? 'auth_failed',
        `OMS auth failed: ${body.msg ?? res.status}`
      );
    }
    tokenCache = {
      key: this.cfg.apiKey,
      token: body.accessToken,
      expiresAt: now + (body.expiresIn ?? 3600) * 1000
    };
    return body.accessToken;
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.f(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      // A revoked or rotated token: fetch a fresh one once.
      if (res.status === 401 && attempt === 0) {
        tokenCache = null;
        continue;
      }
      const data = (await res.json().catch(() => ({}))) as T & { error?: string; msg?: string };
      if (!res.ok) {
        throw new OmsError(
          res.status,
          data.error ?? 'oms_error',
          `OMS ${method} ${path} failed: ${data.msg ?? res.status}`
        );
      }
      return data;
    }
  }

  async findByWallet(wallet: string): Promise<Customer | null> {
    const q = new URLSearchParams({ externalId: wallet.toLowerCase(), limit: '10' });
    const res = await this.call<{ data?: Customer[] }>('GET', `/customers?${q}`);
    return (res.data ?? []).find((c) => c.status !== 'inactive') ?? null;
  }

  async create(
    wallet: string,
    email: string | null,
    metadata: Record<string, string>
  ): Promise<Customer> {
    return this.call<Customer>(
      'POST',
      '/customers',
      {
        type: 'individual',
        externalId: wallet.toLowerCase(),
        ...(email ? { email } : {}),
        // The least OMS offers; without this it requests custody and USD endorsements.
        endorsements: ['basic'],
        metadata: { agentconnect_wallet: wallet.toLowerCase(), ...metadata }
      },
      { 'Idempotency-Key': `agentconnect-customer-${wallet.toLowerCase()}` }
    );
  }

  async updateMetadata(id: string, metadata: Record<string, string>): Promise<Customer> {
    return this.call<Customer>('PATCH', `/customers/${encodeURIComponent(id)}`, { metadata });
  }

  /** Write metadata onto the wallet's customer, creating it on first use. */
  async upsertMetadata(
    wallet: string,
    email: string | null,
    metadata: Record<string, string>
  ): Promise<Customer> {
    const existing = await this.findByWallet(wallet);
    if (!existing) return this.create(wallet, email, metadata);
    return this.updateMetadata(existing.id, { ...(existing.metadata ?? {}), ...metadata });
  }
}

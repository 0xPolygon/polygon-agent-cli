// VGS Agent Web Gateway: a reveal session per checkout turns a card's vault
// aliases into session aliases that only work through that session's proxy,
// and only for the hosts we name. The browser types session aliases; VGS puts
// the real card in on the way to the store. Plain JSON:API REST with a
// service account's access token.
//
// The create response is the only one carrying the proxy password and the
// session aliases: keep them server-side, never in tool results or logs.

const API = { sandbox: 'https://sandbox.vgsapi.com', live: 'https://vgsapi.com' } as const;
const AUTH_URL = 'https://auth.verygoodsecurity.com/auth/realms/vgs/protocol/openid-connect/token';
const JSON_API = 'application/vnd.api+json';

// Limits of the API (version 2026-11-12).
export const MAX_ALLOWED_HOSTS = 20;
export const MAX_SESSION_PARTS = 20;

export interface VgsConfig {
  clientId: string;
  clientSecret: string;
  vaultId: string;
  environment?: keyof typeof API;
  fetchImpl?: typeof fetch;
}

export class VgsError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export interface AliasRef {
  alias: string;
  // Card number: needed unless the alias is itself a 13-19 digit number.
  bin?: string;
  length?: number;
  // CVC aliases are VOLATILE (an hour at most); card numbers are PERSISTENT.
  storage?: 'PERSISTENT' | 'VOLATILE';
}

export interface RevealCard {
  // Needed when the session has more than one card.
  label?: string;
  number: AliasRef;
  cvc?: AliasRef;
  expiry?: AliasRef;
  holder?: AliasRef;
}

export interface CreateRevealSession {
  cards: RevealCard[];
  // Exact host names the session's aliases may reach: no wildcard, port or IP.
  allowedHosts: string[];
  // Ours, for matching the session back to a checkout (e.g. checkout_id).
  context?: Record<string, string>;
}

export type RevealSessionState = 'active' | 'revoked' | 'expired';

/** What creating a session returns, once. Secret: see the note at the top. */
export interface RevealSession {
  id: string;
  state: RevealSessionState;
  expiresAt: string;
  cards: { label?: string; number: string; cvc?: string; expiry?: string; holder?: string }[];
  proxy: { url: string; caBundle: string; pacUrl: string };
}

/** A later read of a session: never any secrets. */
export interface RevealSessionStatus {
  id: string;
  state: RevealSessionState;
  expiresAt: string;
  allowedHosts: string[];
  revealCount: number;
  refusalCount: number;
}

export interface ProxyParts {
  scheme: string;
  host: string;
  port: number;
  username: string;
  password: string;
}

/** The parts of a session's `proxy.url` (`<scheme>://<session id>:<secret>@<host>:<port>`). */
export function proxyParts(url: string): ProxyParts {
  const u = new URL(url);
  const scheme = u.protocol.replace(/:$/, '');
  return {
    scheme,
    host: u.hostname,
    port: Number(u.port || (scheme === 'https' ? 443 : 80)),
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password)
  };
}

/** A session as it may be logged: no proxy password, no session aliases. */
export function loggable(s: RevealSession): { id: string; state: string; expiresAt: string } {
  return { id: s.id, state: s.state, expiresAt: s.expiresAt };
}

const HOST = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Hosts as the API takes them, or a VgsError naming the first one it would refuse. */
export function checkAllowedHosts(hosts: string[]): string[] {
  const out = [...new Set(hosts.map((h) => h.trim().toLowerCase()))];
  if (out.length > MAX_ALLOWED_HOSTS) {
    throw new VgsError(400, 'too_many_hosts', `At most ${MAX_ALLOWED_HOSTS} allowed hosts`);
  }
  for (const h of out) {
    if (!HOST.test(h) || IPV4.test(h)) {
      throw new VgsError(400, 'invalid_host', `Not an exact host name: ${h}`);
    }
  }
  return out;
}

// Access tokens last 20 minutes and refresh tokens must not be used: reuse
// each service account's token until close to expiry, then ask again.
const tokens = new Map<string, { token: string; expiresAt: number }>();

export function resetVgsTokenCache(): void {
  tokens.clear();
}

export class Vgs {
  private readonly base: string;
  private readonly f: typeof fetch;

  constructor(private readonly cfg: VgsConfig) {
    this.base = API[cfg.environment ?? 'sandbox'];
    // Unbound: Workers throw "Illegal invocation" when fetch is called as a method.
    this.f = cfg.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private async token(): Promise<string> {
    const now = Date.now();
    const cached = tokens.get(this.cfg.clientId);
    if (cached && cached.expiresAt - 60_000 > now) return cached.token;
    const res = await this.f(AUTH_URL, {
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
    };
    if (!res.ok || !body.access_token) {
      throw new VgsError(
        res.status,
        body.error ?? 'auth_failed',
        `VGS sign-in failed: ${res.status}`
      );
    }
    tokens.set(this.cfg.clientId, {
      token: body.access_token,
      expiresAt: now + (body.expires_in ?? 1200) * 1000
    });
    return body.access_token;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.f(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          'VGS-Tenant': this.cfg.vaultId,
          Accept: JSON_API,
          ...(body === undefined ? {} : { 'Content-Type': JSON_API })
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if (res.status === 401 && attempt === 0) {
        tokens.delete(this.cfg.clientId);
        continue;
      }
      if (res.status === 204) return null;
      const data = (await res.json().catch(() => ({}))) as T & {
        errors?: { code?: string; title?: string }[];
      };
      if (!res.ok) {
        // Only the code and title: details can echo what we sent.
        const e = data.errors?.[0];
        throw new VgsError(
          res.status,
          e?.code ?? 'vgs_error',
          `VGS ${method} ${path.split('?')[0]} failed: ${e?.title ?? res.status}${e?.code ? ` (${e.code})` : ''}`
        );
      }
      return data;
    }
  }

  /** A session for one checkout. Its lifetime comes from the tenant's settings (5 minutes by default). */
  async createRevealSession(input: CreateRevealSession): Promise<RevealSession> {
    if (input.cards.length === 0) throw new VgsError(400, 'missing_aliases', 'No card to reveal');
    if (input.cards.length > 1 && input.cards.some((c) => !c.label)) {
      throw new VgsError(400, 'invalid_card_label', 'Each card needs a label');
    }
    const parts = input.cards.reduce(
      (n, c) => n + [c.number, c.cvc, c.expiry, c.holder].filter(Boolean).length,
      0
    );
    if (parts > MAX_SESSION_PARTS) {
      throw new VgsError(400, 'too_many_aliases', `At most ${MAX_SESSION_PARTS} aliases`);
    }
    const doc = await this.call<SessionDocument>('POST', '/reveal-sessions', {
      data: {
        type: 'reveal-sessions',
        attributes: {
          allowed_hosts: checkAllowedHosts(input.allowedHosts),
          cards: input.cards,
          ...(input.context ? { context: input.context } : {})
        }
      }
    });
    const a = doc?.data?.attributes;
    if (!doc?.data?.id || !a?.proxy?.url || !a.proxy.ca_bundle || !a.proxy.pac_url || !a.cards) {
      throw new VgsError(
        502,
        'unexpected_response',
        'VGS created a session without its proxy or cards'
      );
    }
    return {
      id: doc.data.id,
      state: a.state ?? 'active',
      expiresAt: a.expires_at ?? '',
      cards: a.cards.map((c) => ({
        ...(c.label ? { label: c.label } : {}),
        number: c.number?.value ?? '',
        ...(c.cvc?.value ? { cvc: c.cvc.value } : {}),
        ...(c.expiry?.value ? { expiry: c.expiry.value } : {}),
        ...(c.holder?.value ? { holder: c.holder.value } : {})
      })),
      proxy: { url: a.proxy.url, caBundle: a.proxy.ca_bundle, pacUrl: a.proxy.pac_url }
    };
  }

  /** The session's state, or null if VGS doesn't know it. */
  async getRevealSession(id: string): Promise<RevealSessionStatus | null> {
    try {
      const doc = await this.call<SessionDocument>('GET', `/reveal-sessions/${enc(id)}`);
      const a = doc?.data?.attributes ?? {};
      return {
        id,
        state: a.state ?? 'expired',
        expiresAt: a.expires_at ?? '',
        allowedHosts: a.allowed_hosts ?? [],
        revealCount: a.reveal_count ?? 0,
        refusalCount: a.refusal_count ?? 0
      };
    } catch (err) {
      if (err instanceof VgsError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Ends a session now; revoking twice is fine. A tenant without revocation
   * answers 409 `revocation_list_disabled`: the session then only expires.
   */
  async revokeRevealSession(id: string): Promise<void> {
    await this.call('DELETE', `/reveal-sessions/${enc(id)}`).catch((err) => {
      if (!(err instanceof VgsError && err.status === 404)) throw err;
    });
  }

  /**
   * The tenant's forward proxy CA, the same for every session: a browser can
   * trust it before any session exists.
   */
  async proxyCa(): Promise<{ host: string; scheme: string; port: number; caBundle: string }> {
    const doc = await this.call<{
      data?: { attributes?: { host?: string; scheme?: string; port?: number; ca_bundle?: string } };
    }>('GET', '/reveal-sessions/proxy-ca');
    const a = doc?.data?.attributes;
    if (!a?.ca_bundle) throw new VgsError(502, 'unexpected_response', 'VGS returned no CA bundle');
    return {
      host: a.host ?? '',
      scheme: a.scheme ?? 'https',
      port: a.port ?? 0,
      caBundle: a.ca_bundle
    };
  }
}

interface SessionDocument {
  data?: {
    id?: string;
    attributes?: {
      state?: RevealSessionState;
      expires_at?: string;
      allowed_hosts?: string[];
      reveal_count?: number;
      refusal_count?: number;
      cards?: {
        label?: string;
        number?: { value?: string };
        cvc?: { value?: string };
        expiry?: { value?: string };
        holder?: { value?: string };
      }[];
      proxy?: { url?: string; ca_bundle?: string; pac_url?: string };
    };
  };
}

const enc = encodeURIComponent;

// Kernel (kernel.sh): hosted browsers, and its vault, which holds a store's
// card request while the owner approves it with AgentCard. Plain REST; the
// browser itself is driven through Kernel's Playwright execution with fixed
// code from browser-checkout.ts.

const BASE = 'https://api.onkernel.com';

export class KernelError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface KernelBrowser {
  session_id: string;
  browser_live_view_url?: string;
}

export interface AgentCardAuthorization {
  id: string;
  status: 'awaiting_approval' | 'approved' | 'declined' | 'expired';
  approval_url?: string;
  amount_cents: number;
  currency: string;
  merchant: string;
  reason?: string;
  charged_kind?: 'captured' | 'authorized' | 'none';
  replay_delivered?: boolean;
  browser_id?: string;
  created_at?: string;
  expires_at?: string;
}

export interface VaultItem {
  key: string;
  type: string;
  spec: Record<string, unknown>;
  state: {
    status: string;
    status_reason?: string;
    aliases?: { number: string; cvc: string; exp_month: string; exp_year: string };
    authorization?: AgentCardAuthorization;
    masks?: { brand?: string; last4?: string };
  };
  action?: { name: string; url: string };
}

export interface PlaywrightResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

// Provider configurations this isolate has registered, by name.
const registered = new Map<string, Promise<void>>();

export class Kernel {
  /** Kernel's AgentCard provider configuration for `agentcard`, the deployment's own client. */
  readonly providerConfig: string;

  constructor(
    private readonly apiKey: string,
    prefix: string,
    private readonly agentcard: { clientId: string; clientSecret: string }
  ) {
    // Named after the client, so the configuration always holds the client
    // that created the wallet's AgentCard users.
    this.providerConfig = `${prefix}-${agentcard.clientId.slice(0, 8)}`;
  }

  /** Registers this deployment's AgentCard client with Kernel, once (a 409 means it already is). */
  ensureProviderConfig(): Promise<void> {
    let p = registered.get(this.providerConfig);
    if (!p) {
      p = this.call('POST', '/vault-provider-configs', {
        name: this.providerConfig,
        provider: 'agentcard',
        credentials: {
          client_id: this.agentcard.clientId,
          client_secret: this.agentcard.clientSecret
        }
      }).then(
        () => undefined,
        (err) => {
          if (err instanceof KernelError && err.status === 409) return;
          registered.delete(this.providerConfig);
          throw err;
        }
      );
      registered.set(this.providerConfig, p);
    }
    return p;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { message?: string; error?: { message?: string } | string };
        message =
          j.message ?? (typeof j.error === 'string' ? j.error : j.error?.message) ?? message;
      } catch {
        // not JSON: keep the text
      }
      throw new KernelError(res.status, message);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  vault(name: string): Promise<{ id: string; name: string }> {
    return this.call('POST', '/vaults', { name });
  }

  async getItem(vault: string, key: string, waitSec = 0): Promise<VaultItem | null> {
    try {
      return await this.call<VaultItem>(
        'GET',
        `/vaults/${enc(vault)}/items/${enc(key)}${waitSec ? `?wait=${waitSec}` : ''}`
      );
    } catch (err) {
      if (err instanceof KernelError && err.status === 404) return null;
      throw err;
    }
  }

  putItem(vault: string, key: string, item: { type: string; spec: unknown }): Promise<VaultItem> {
    return this.call('PUT', `/vaults/${enc(vault)}/items/${enc(key)}`, item);
  }

  updateItem(
    vault: string,
    key: string,
    item: { type: string; spec: unknown }
  ): Promise<VaultItem> {
    return this.call('PATCH', `/vaults/${enc(vault)}/items/${enc(key)}`, item);
  }

  async deleteItem(vault: string, key: string): Promise<void> {
    await this.call('DELETE', `/vaults/${enc(vault)}/items/${enc(key)}`).catch((err) => {
      if (!(err instanceof KernelError && err.status === 404)) throw err;
    });
  }

  createBrowser(opts: {
    vault: string;
    timeoutSeconds: number;
    startUrl?: string;
  }): Promise<KernelBrowser> {
    return this.call('POST', '/browsers', {
      vaults: [{ name: opts.vault }],
      stealth: true,
      headless: false,
      timeout_seconds: opts.timeoutSeconds,
      viewport: { width: 1280, height: 900 },
      ...(opts.startUrl ? { start_url: opts.startUrl } : {})
    });
  }

  async deleteBrowser(id: string): Promise<void> {
    await this.call('DELETE', `/browsers/${enc(id)}`).catch((err) => {
      if (!(err instanceof KernelError && err.status === 404)) throw err;
    });
  }

  /** Runs one of our fixed scripts in the browser; `args` reach it as data, never as code. */
  playwright(browserId: string, code: string, args: unknown, timeoutSec = 60) {
    return this.call<PlaywrightResult>('POST', `/browsers/${enc(browserId)}/playwright/execute`, {
      code: `const ARGS = ${JSON.stringify(args ?? {})};\n${code}`,
      timeout_sec: timeoutSec
    });
  }
}

const enc = encodeURIComponent;

// packages/polygon-agent-cli/src/lib/relay-client.ts
import type {
  EncryptedPayload,
  RelayCreateResponse,
  RelayStatusResponse
} from '@polygonlabs/agent-shared';

export class RelayClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /** Register CLI public key with relay. Returns request_id. */
  async createRequest(cliPkHex: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/relay/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cli_pk_hex: cliPkHex })
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Relay createRequest failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as RelayCreateResponse;
    return data.request_id;
  }

  /** Poll until status is "ready" or timeout. Calls onPolling each interval. */
  async waitForReady(
    requestId: string,
    timeoutMs = 300_000,
    intervalMs = 2_000,
    onPolling?: () => void
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await fetch(`${this.baseUrl}/api/relay/status/${requestId}`);
      if (res.status === 404) throw new Error('Relay request not found (expired or invalid)');
      if (!res.ok) throw new Error(`Relay status check failed (${res.status})`);
      const data = (await res.json()) as RelayStatusResponse;
      if (data.status === 'ready') return;
      onPolling?.();
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error('Timed out waiting for wallet approval (5 minutes)');
  }

  /** Submit code hash and retrieve encrypted payload if correct. */
  async retrieve(requestId: string, codeHashHex: string): Promise<EncryptedPayload> {
    const res = await fetch(`${this.baseUrl}/api/relay/retrieve/${requestId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code_hash_hex: codeHashHex })
    });

    if (res.status === 403) {
      const data = (await res.json()) as { attempts_remaining: number };
      throw new RelayCodeError(
        `Wrong code. ${data.attempts_remaining} attempt(s) remaining.`,
        data.attempts_remaining
      );
    }
    if (res.status === 410)
      throw new RelayCodeError('Too many wrong attempts. Session expired.', 0);
    if (!res.ok) throw new Error(`Relay retrieve failed (${res.status})`);

    return (await res.json()) as EncryptedPayload;
  }
}

export class RelayCodeError extends Error {
  readonly attemptsRemaining: number;

  constructor(message: string, attemptsRemaining: number) {
    super(message);
    this.name = 'RelayCodeError';
    this.attemptsRemaining = attemptsRemaining;
  }
}

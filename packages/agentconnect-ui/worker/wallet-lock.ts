// One Durable Object per wallet, so claiming a payment is atomic: of two
// requests to pay the same approval or quote, exactly one gets the claim, even
// on different workers at the same moment (Workers KV has no atomic write).
//
// It has no route. Only this worker reaches it, through the WALLET_LOCK
// binding; nothing on the internet can address it.

import type { Env } from './index.ts';

// How long a claim is remembered. Approvals and quotes are long settled by then.
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const PREFIX = 'claim:';

interface LockStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  delete(keys: string[]): Promise<number>;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
}

export class WalletLock {
  private readonly storage: LockStorage;
  // Claims run one after another. The runtime already holds other requests
  // while a storage call is in flight; this keeps that true by construction.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(state: { storage: LockStorage }) {
    this.storage = state.storage;
  }

  /** POST /claim {"key"} → {"claimed": true} for the first caller only. */
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/claim') {
      return new Response(null, { status: 404 });
    }
    const { key } = (await request.json()) as { key?: unknown };
    if (typeof key !== 'string' || !key || key.length > 200) {
      return new Response(null, { status: 400 });
    }
    const claimed = this.queue.then(() => this.claim(key));
    this.queue = claimed.catch(() => undefined);
    return Response.json({ claimed: await claimed });
  }

  // No other claim can land between this read and the write.
  private async claim(key: string): Promise<boolean> {
    if ((await this.storage.get<number>(PREFIX + key)) !== undefined) return false;
    await this.storage.put(PREFIX + key, Date.now());
    if ((await this.storage.getAlarm()) === null) await this.storage.setAlarm(Date.now() + KEEP_MS);
    return true;
  }

  /** Forget claims older than KEEP_MS. */
  async alarm(): Promise<void> {
    const cutoff = Date.now() - KEEP_MS;
    const claims = await this.storage.list<number>({ prefix: PREFIX });
    const old = [...claims].filter(([, at]) => at < cutoff).map(([k]) => k);
    if (old.length) await this.storage.delete(old);
    if (claims.size > old.length) await this.storage.setAlarm(Date.now() + KEEP_MS);
  }
}

/** Claims a payment once per wallet. */
export interface PaymentLock {
  claim(key: string): Promise<boolean>;
}

/** The wallet's lock, or null where the binding isn't configured (tests, local). */
export function walletLock(env: Env, wallet: string): PaymentLock | null {
  const ns = env.WALLET_LOCK;
  if (!ns) return null;
  const stub = ns.get(ns.idFromName(wallet.toLowerCase()));
  return {
    async claim(key) {
      const res = await stub.fetch('https://wallet-lock/claim', {
        method: 'POST',
        body: JSON.stringify({ key })
      });
      if (!res.ok) throw new Error(`wallet lock answered ${res.status}`);
      return ((await res.json()) as { claimed: boolean }).claimed;
    }
  };
}

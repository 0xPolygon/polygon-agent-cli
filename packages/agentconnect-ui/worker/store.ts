// Saved credentials, one KV record per agent wallet. Records are sealed with
// AES-GCM under a key derived from CREDENTIALS_KEY, bound to the wallet so a
// record can't be read back under another wallet's key.

import type { ShippingAddress } from './shipping.ts';

import { b64urlDecode, b64urlEncode } from './agent-auth.ts';

// A purchase over the owner's auto-pay limit, waiting for them to approve on
// the approval page. `cart` purchases are placed by the worker once approved;
// `checkout` ones (any store, in the agent's own browser) get a one-time card
// for the total. Checkouts under the limit are kept too, already approved.
export interface Approval {
  id: string;
  kind: 'cart' | 'checkout';
  merchant: string;
  merchantUrl: string | null;
  totalCents: number;
  items: { name: string; qty: number; priceCents?: number }[];
  conversationId: string | null;
  hash: string | null;
  // `placing`: approved, and the worker is placing the cart right now.
  status:
    | 'pending'
    | 'placing'
    | 'approved'
    | 'declined'
    | 'placed'
    | 'failed'
    | 'awaiting_passkey'
    | 'canceled';
  autoApproved?: boolean;
  // A checkout's one-time card: display fields only, never the number.
  card?: { id: string; last4: string | null; status: string; closedReason?: string } | null;
  // Set once the cart was confirmed: what the store and AgentCard said.
  result?: Record<string, unknown> | null;
  createdAt: string;
  decidedAt?: string;
}

// A priced cart shown to the user before anything is charged (clients whose
// profile confirms each purchase). Confirming must name the same total.
export interface Quote {
  id: string;
  merchant: string;
  totalCents: number;
  items: { name: string; qty: number; priceCents?: number }[];
  conversationId: string;
  hash: string;
  createdAt: string;
  expiresAt: string;
  // Set once confirmed, so a repeated confirm returns the outcome instead of paying twice.
  confirmedAt?: string;
  result?: Record<string, unknown> | null;
}

export interface WalletRecord {
  address?: ShippingAddress | null;
  // AgentCard vault users this wallet has linked (a returning user may come
  // back as a new one), and its recent add-a-card sessions (so a wallet can
  // only finish its own, and a second link doesn't strand the first).
  agentcardUsers?: string[];
  agentcardSessions?: string[];
  /** @deprecated The single session kept before `agentcardSessions`. */
  agentcardSession?: string;
  // Tokens that act as the vault user with the card, for purchases. Taken
  // once from a linked add-a-card session; the refresh token rotates.
  // Purchases at or under this pay without asking; over it, the owner approves.
  autoPayLimitCents?: number;
  approvals?: Approval[];
  quotes?: Quote[];
  agentcardConnection?: {
    userId: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  } | null;
}

const VERSION = 'v1';
const enc = new TextEncoder();
const dec = new TextDecoder();

const keyName = (wallet: string) => `wallet:${wallet.toLowerCase()}`;
// Keyed by a hash so the KV listing doesn't show owners' emails.
async function ownerKey(email: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(email.trim().toLowerCase()));
  return `owner:${b64urlEncode(new Uint8Array(digest))}`;
}

/**
 * JSON values in Workers KV, sealed with AES-GCM. The KV key is the additional
 * data, so a value copied under another key fails to open.
 */
export class SealedKv {
  private key: Promise<CryptoKey>;

  constructor(
    private readonly kv: KVNamespace,
    secret: string
  ) {
    this.key = deriveKey(secret);
  }

  async get<T>(name: string): Promise<T | null> {
    const sealed = await this.kv.get(name);
    return sealed ? openSealed<T>(await this.key, name, sealed) : null;
  }

  async put(name: string, value: unknown, opts?: { expirationTtl?: number }): Promise<void> {
    await this.kv.put(name, await seal(await this.key, name, value), opts);
  }
}

export class CredentialStore {
  private sealed: SealedKv;

  constructor(kv: KVNamespace, secret: string) {
    this.sealed = new SealedKv(kv, secret);
  }

  async get(wallet: string): Promise<WalletRecord> {
    return (await this.sealed.get<WalletRecord>(keyName(wallet))) ?? {};
  }

  /** Which wallet an approval belongs to, for the approval page (it has no agent token). */
  async linkApproval(id: string, wallet: string): Promise<void> {
    await this.sealed.put(`approval:${id}`, wallet.toLowerCase(), {
      expirationTtl: 30 * 24 * 3600
    });
  }

  async approvalWallet(id: string): Promise<string | null> {
    return /^apr_[0-9a-f]{24}$/.test(id) ? this.sealed.get<string>(`approval:${id}`) : null;
  }

  /**
   * The agent wallet an owner's verified email linked last. OMS gives each
   * sign-in method its own wallet, so a dashboard sign-in by email code can
   * land on a different wallet than the agent's Google one; this ties them.
   */
  async linkOwner(email: string, wallet: string): Promise<void> {
    await this.sealed.put(await ownerKey(email), wallet.toLowerCase());
  }

  async ownerWallet(email: string): Promise<string | null> {
    return this.sealed.get<string>(await ownerKey(email));
  }

  /** Read, change, and write back the wallet's record. */
  async update(wallet: string, change: (r: WalletRecord) => WalletRecord): Promise<WalletRecord> {
    const next = change(await this.get(wallet));
    await this.sealed.put(keyName(wallet), next);
    return next;
  }
}

/** A JSON value sealed with AES-GCM, bound to `name` as additional data. */
export async function seal(key: CryptoKey, name: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(name) },
    key,
    enc.encode(JSON.stringify(value))
  );
  return `${VERSION}.${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(data))}`;
}

export async function openSealed<T>(key: CryptoKey, name: string, sealed: string): Promise<T> {
  const [version, iv, data] = sealed.split('.');
  if (version !== VERSION || !iv || !data) throw new Error(`Unreadable record for ${name}`);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64urlDecode(iv), additionalData: enc.encode(name) },
    key,
    b64urlDecode(data)
  );
  return JSON.parse(dec.decode(plain)) as T;
}

export async function deriveKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, [
    'deriveKey'
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: enc.encode('agentconnect-credentials-v1')
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Saved credentials, one KV record per agent wallet. Records are sealed with
// AES-GCM under a key derived from CREDENTIALS_KEY, bound to the wallet so a
// record can't be read back under another wallet's key.

import type { ShippingAddress } from './shipping.ts';

import { b64urlDecode, b64urlEncode } from './agent-auth.ts';

export interface WalletRecord {
  address?: ShippingAddress | null;
  // AgentCard vault users this wallet has linked (a returning user may come
  // back as a new one), and the add-a-card session in flight (so a wallet can
  // only finish its own session).
  agentcardUsers?: string[];
  agentcardSession?: string;
}

const VERSION = 'v1';
const enc = new TextEncoder();
const dec = new TextDecoder();

const keyName = (wallet: string) => `wallet:${wallet.toLowerCase()}`;

export class CredentialStore {
  private key: Promise<CryptoKey>;

  constructor(
    private readonly kv: KVNamespace,
    secret: string
  ) {
    this.key = deriveKey(secret);
  }

  async get(wallet: string): Promise<WalletRecord> {
    const name = keyName(wallet);
    const sealed = await this.kv.get(name);
    if (!sealed) return {};
    const [version, iv, data] = sealed.split('.');
    if (version !== VERSION || !iv || !data) throw new Error(`Unreadable record for ${name}`);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64urlDecode(iv), additionalData: enc.encode(name) },
      await this.key,
      b64urlDecode(data)
    );
    return JSON.parse(dec.decode(plain)) as WalletRecord;
  }

  /** Read, change, and write back the wallet's record. */
  async update(wallet: string, change: (r: WalletRecord) => WalletRecord): Promise<WalletRecord> {
    const name = keyName(wallet);
    const next = change(await this.get(wallet));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(name) },
      await this.key,
      enc.encode(JSON.stringify(next))
    );
    await this.kv.put(name, `${VERSION}.${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(data))}`);
    return next;
  }
}

async function deriveKey(secret: string): Promise<CryptoKey> {
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

// Sealed values in Workers KV: sign-ins in progress (owner-signin.ts) are kept
// under a key derived from CREDENTIALS_KEY.

import { b64urlDecode, b64urlEncode } from './agent-auth.ts';

const VERSION = 'v1';
const enc = new TextEncoder();
const dec = new TextDecoder();

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
    if (!sealed) return null;
    const [version, iv, data] = sealed.split('.');
    if (version !== VERSION || !iv || !data) throw new Error(`Unreadable record for ${name}`);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64urlDecode(iv), additionalData: enc.encode(name) },
      await this.key,
      b64urlDecode(data)
    );
    return JSON.parse(dec.decode(plain)) as T;
  }

  async put(name: string, value: unknown, opts?: { expirationTtl?: number }): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(name) },
      await this.key,
      enc.encode(JSON.stringify(value))
    );
    await this.kv.put(
      name,
      `${VERSION}.${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(data))}`,
      opts
    );
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

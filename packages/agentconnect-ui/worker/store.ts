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
    return sealed ? openSealed<T>(await this.key, name, sealed) : null;
  }

  async put(name: string, value: unknown, opts?: { expirationTtl?: number }): Promise<void> {
    await this.kv.put(name, await seal(await this.key, name, value), opts);
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

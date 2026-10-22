// Signing and encoding helpers for the site's own tokens (the owner's session
// cookie, owner-session.ts).

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

// ── base64url ──

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export const encodeJson = (v: unknown) => b64urlEncode(enc.encode(JSON.stringify(v)));

export function decodeJson<T>(s: string): T {
  try {
    return JSON.parse(dec.decode(b64urlDecode(s))) as T;
  } catch {
    throw new AuthError('malformed', 'Malformed token');
  }
}

// ── HMAC ──

export async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return b64urlEncode(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data))));
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

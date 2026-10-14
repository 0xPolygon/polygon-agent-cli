// Agent sign-in for the credentials API.
//
// 1. Enrollment: while the owner is signed in, the CLI asks OMS for an ID
//    token naming its own agent key in custom_claims. We verify that token
//    against the OMS JWKS and issue a certificate binding the key to the
//    wallet (HMAC-signed, so no server state).
// 2. Requests: the agent mints short-lived access tokens offline, signing them
//    with the agent key. The same tokens go in dashboard links (URL fragment).
//
// Token formats (mirrored in packages/polygon-agent-cli/src/lib/credentials):
//   certificate  c1.<payload>.<hmac>
//   access token at1.<cert payload>.<cert hmac>.<payload>.<0x signature>
// The signature is EIP-191 over `agentconnect:` + everything before it.

import { recoverMessageAddress } from 'viem';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const ENROLL_PURPOSE = 'agentconnect-enroll';
export const TOKEN_AUDIENCE = 'agentconnect';
export const CERT_TTL_SECONDS = 30 * 24 * 60 * 60;
// Longest access token we accept, whatever the agent asked for.
export const MAX_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 60;

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

function decodeJson<T>(s: string): T {
  try {
    return JSON.parse(dec.decode(b64urlDecode(s))) as T;
  } catch {
    throw new AuthError('malformed', 'Malformed token');
  }
}

// ── OMS ID token (ES256 JWT) ──

export interface OmsIdTokenConfig {
  jwksUrl: string;
  issuer: string;
  audiences: string[];
  fetchImpl?: typeof fetch;
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

let jwksCache: { url: string; keys: Jwk[]; at: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function jwks(cfg: OmsIdTokenConfig, refresh = false): Promise<Jwk[]> {
  if (
    !refresh &&
    jwksCache &&
    jwksCache.url === cfg.jwksUrl &&
    Date.now() - jwksCache.at < JWKS_TTL_MS
  ) {
    return jwksCache.keys;
  }
  const res = await (cfg.fetchImpl ?? fetch)(cfg.jwksUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  jwksCache = { url: cfg.jwksUrl, keys: body.keys ?? [], at: Date.now() };
  return jwksCache.keys;
}

export function resetJwksCache(): void {
  jwksCache = null;
}

export interface EnrollClaims {
  wallet: string;
  agentKey: string;
  email: string | null;
}

/** Verify an OMS-issued ID token minted for enrollment and return what it vouches for. */
export async function verifyEnrollToken(
  jwt: string,
  cfg: OmsIdTokenConfig,
  now = Math.floor(Date.now() / 1000)
): Promise<EnrollClaims> {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new AuthError('malformed', 'Malformed ID token');
  const header = decodeJson<{ alg?: string; kid?: string }>(parts[0]);
  if (header.alg !== 'ES256' || !header.kid) {
    throw new AuthError('bad_signature', 'Unsupported ID token algorithm');
  }
  let key = (await jwks(cfg)).find((k) => k.kid === header.kid);
  if (!key) key = (await jwks(cfg, true)).find((k) => k.kid === header.kid);
  if (!key) throw new AuthError('bad_signature', 'Unknown ID token key');

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    { kty: key.kty, crv: key.crv, x: key.x, y: key.y },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    b64urlDecode(parts[2]),
    enc.encode(`${parts[0]}.${parts[1]}`)
  );
  if (!ok) throw new AuthError('bad_signature', 'ID token signature is invalid');

  const claims = decodeJson<{
    iss?: string;
    aud?: string | string[];
    exp?: number;
    iat?: number;
    email?: string;
    email_verified?: boolean;
    wallet_address?: string;
    custom_claims?: { agent_key?: string; purpose?: string } | string;
  }>(parts[1]);

  if (claims.iss !== cfg.issuer) throw new AuthError('bad_claims', 'Unexpected ID token issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!aud.some((a) => cfg.audiences.includes(a))) {
    throw new AuthError('bad_claims', 'ID token is for another project');
  }
  if (typeof claims.exp !== 'number' || claims.exp < now - CLOCK_SKEW_SECONDS) {
    throw new AuthError('expired', 'ID token has expired');
  }
  if (typeof claims.iat === 'number' && claims.iat > now + CLOCK_SKEW_SECONDS) {
    throw new AuthError('bad_claims', 'ID token is from the future');
  }
  let custom: { agent_key?: string; purpose?: string } = {};
  try {
    custom =
      typeof claims.custom_claims === 'string'
        ? JSON.parse(claims.custom_claims)
        : (claims.custom_claims ?? {});
  } catch {
    throw new AuthError('bad_claims', 'ID token custom claims are malformed');
  }
  if (custom.purpose !== ENROLL_PURPOSE) {
    throw new AuthError('bad_claims', 'ID token was not minted for enrollment');
  }
  if (!claims.wallet_address || !ADDRESS.test(claims.wallet_address)) {
    throw new AuthError('bad_claims', 'ID token has no wallet address');
  }
  if (!custom.agent_key || !ADDRESS.test(custom.agent_key)) {
    throw new AuthError('bad_claims', 'ID token has no agent key');
  }
  return {
    wallet: claims.wallet_address.toLowerCase(),
    agentKey: custom.agent_key.toLowerCase(),
    email: claims.email && claims.email_verified ? claims.email : null
  };
}

// ── Certificate (HMAC) ──

export interface Certificate {
  w: string;
  k: string;
  e: string | null;
  iat: number;
  exp: number;
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return b64urlEncode(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data))));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function issueCertificate(
  claims: EnrollClaims,
  secret: string,
  now = Math.floor(Date.now() / 1000)
): Promise<{ certificate: string; expiresAt: number }> {
  const payload = encodeJson({
    w: claims.wallet,
    k: claims.agentKey,
    e: claims.email,
    iat: now,
    exp: now + CERT_TTL_SECONDS
  } satisfies Certificate);
  return {
    certificate: `c1.${payload}.${await hmac(secret, `c1.${payload}`)}`,
    expiresAt: now + CERT_TTL_SECONDS
  };
}

// ── Access token ──

export interface AgentIdentity {
  wallet: string;
  agentKey: string;
  email: string | null;
}

/** Verify an `at1` access token; returns who it speaks for. */
export async function verifyAccessToken(
  token: string,
  secret: string,
  now = Math.floor(Date.now() / 1000)
): Promise<AgentIdentity> {
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== 'at1') throw new AuthError('malformed', 'Malformed token');
  const [, certPayload, certMac, payload, signature] = parts;

  if (!safeEqual(await hmac(secret, `c1.${certPayload}`), certMac)) {
    throw new AuthError('bad_signature', 'Certificate is invalid');
  }
  const cert = decodeJson<Certificate>(certPayload);
  if (cert.exp < now) throw new AuthError('expired', 'Agent certificate has expired');

  const claims = decodeJson<{ w?: string; k?: string; iat?: number; exp?: number; aud?: string }>(
    payload
  );
  if (claims.aud !== TOKEN_AUDIENCE)
    throw new AuthError('bad_claims', 'Token is for another service');
  if (claims.w !== cert.w || claims.k !== cert.k) {
    throw new AuthError('bad_claims', 'Token does not match its certificate');
  }
  if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') {
    throw new AuthError('bad_claims', 'Token has no lifetime');
  }
  if (claims.exp < now) throw new AuthError('expired', 'Token has expired');
  if (claims.iat > now + CLOCK_SKEW_SECONDS || claims.exp - claims.iat > MAX_TOKEN_TTL_SECONDS) {
    throw new AuthError('bad_claims', 'Token lifetime is out of range');
  }
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature))
    throw new AuthError('malformed', 'Malformed signature');

  const signer = await recoverMessageAddress({
    message: `agentconnect:at1.${certPayload}.${certMac}.${payload}`,
    signature: signature as `0x${string}`
  }).catch(() => null);
  if (!signer || signer.toLowerCase() !== cert.k) {
    throw new AuthError('bad_signature', 'Token was not signed by the agent key');
  }
  return { wallet: cert.w, agentKey: cert.k, email: cert.e };
}

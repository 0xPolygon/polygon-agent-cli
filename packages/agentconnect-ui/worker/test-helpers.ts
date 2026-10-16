// Test-only helpers: an OMS-like ES256 issuer and the CLI's access token minting.

import { privateKeyToAccount } from 'viem/accounts';

import { b64urlEncode, ENROLL_PURPOSE, encodeJson, TOKEN_AUDIENCE } from './agent-auth.ts';

export const AGENT_PK =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
export const AGENT = privateKeyToAccount(AGENT_PK);
export const WALLET = '0x00000000000000000000000000000000000000aa';
export const SECRET = 'test-secret-test-secret-test-secret';
export const ISSUER = 'https://api.polygon.technology';
export const AUDIENCE = 'prj_test';

export async function makeIssuer(kid = 'kid-1') {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify'
  ])) as CryptoKeyPair;
  const jwk = {
    ...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
    kid,
    alg: 'ES256',
    use: 'sig'
  };
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })) as unknown as typeof fetch;

  async function sign(claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
    const h = encodeJson({ alg: 'ES256', kid, typ: 'JWT', ...header });
    const p = encodeJson(claims);
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        new TextEncoder().encode(`${h}.${p}`)
      )
    );
    return `${h}.${p}.${b64urlEncode(sig)}`;
  }

  const now = Math.floor(Date.now() / 1000);
  const enrollClaims = (over: Record<string, unknown> = {}) => ({
    iss: ISSUER,
    aud: [AUDIENCE],
    iat: now,
    exp: now + 120,
    email: 'owner@example.com',
    email_verified: true,
    wallet_address: WALLET,
    custom_claims: { agent_key: AGENT.address, purpose: ENROLL_PURPOSE },
    ...over
  });

  return { sign, fetchImpl, enrollClaims };
}

/** What the CLI does: sign an at1 token with the agent key. */
export async function mintAccessToken(
  certificate: string,
  opts: { ttl?: number; iat?: number; account?: typeof AGENT; wallet?: string; aud?: string } = {}
): Promise<string> {
  const [, certPayload, certMac] = certificate.split('.');
  const iat = opts.iat ?? Math.floor(Date.now() / 1000);
  const account = opts.account ?? AGENT;
  const payload = encodeJson({
    w: (opts.wallet ?? WALLET).toLowerCase(),
    k: AGENT.address.toLowerCase(),
    iat,
    exp: iat + (opts.ttl ?? 600),
    aud: opts.aud ?? TOKEN_AUDIENCE
  });
  const body = `at1.${certPayload}.${certMac}.${payload}`;
  const signature = await account.signMessage({ message: `agentconnect:${body}` });
  return `${body}.${signature}`;
}

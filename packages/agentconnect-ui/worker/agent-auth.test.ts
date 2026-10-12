import { privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  AuthError,
  issueCertificate,
  resetJwksCache,
  verifyAccessToken,
  verifyEnrollToken
} from './agent-auth.ts';
import {
  AGENT,
  AUDIENCE,
  ISSUER,
  makeIssuer,
  mintAccessToken,
  SECRET,
  WALLET
} from './test-helpers.ts';

const cfg = (fetchImpl: typeof fetch) => ({
  jwksUrl: 'https://jwks.test',
  issuer: ISSUER,
  audiences: [AUDIENCE],
  fetchImpl
});

beforeEach(() => resetJwksCache());

describe('verifyEnrollToken', () => {
  it('accepts an OMS token naming the agent key', async () => {
    const iss = await makeIssuer();
    const jwt = await iss.sign(iss.enrollClaims());
    await expect(verifyEnrollToken(jwt, cfg(iss.fetchImpl))).resolves.toEqual({
      wallet: WALLET,
      agentKey: AGENT.address.toLowerCase(),
      email: 'owner@example.com'
    });
  });

  it('reads custom claims sent as a JSON string', async () => {
    const iss = await makeIssuer();
    const claims = iss.enrollClaims();
    const jwt = await iss.sign({ ...claims, custom_claims: JSON.stringify(claims.custom_claims) });
    await expect(verifyEnrollToken(jwt, cfg(iss.fetchImpl))).resolves.toMatchObject({
      wallet: WALLET
    });
  });

  it.each([
    ['another issuer', { iss: 'https://evil.example' }],
    ['another project', { aud: ['prj_other'] }],
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 3600 }],
    [
      'a token minted for something else',
      { custom_claims: { agent_key: AGENT.address, purpose: 'login' } }
    ],
    ['no agent key', { custom_claims: { purpose: 'agentconnect-enroll' } }],
    ['no wallet', { wallet_address: undefined }]
  ])('rejects %s', async (_, over) => {
    const iss = await makeIssuer();
    const jwt = await iss.sign(iss.enrollClaims(over));
    await expect(verifyEnrollToken(jwt, cfg(iss.fetchImpl))).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a token signed by a different key', async () => {
    const real = await makeIssuer();
    const forger = await makeIssuer();
    const jwt = await forger.sign(forger.enrollClaims());
    await expect(verifyEnrollToken(jwt, cfg(real.fetchImpl))).rejects.toThrow(/signature/);
  });

  it('drops an unverified email', async () => {
    const iss = await makeIssuer();
    const jwt = await iss.sign(iss.enrollClaims({ email_verified: false }));
    await expect(verifyEnrollToken(jwt, cfg(iss.fetchImpl))).resolves.toMatchObject({
      email: null
    });
  });
});

describe('access tokens', () => {
  const claims = {
    wallet: WALLET,
    agentKey: AGENT.address.toLowerCase(),
    email: 'owner@example.com'
  };

  it('verifies a token the agent signed', async () => {
    const { certificate } = await issueCertificate(claims, SECRET);
    const token = await mintAccessToken(certificate);
    await expect(verifyAccessToken(token, SECRET)).resolves.toEqual(claims);
  });

  it('rejects a token signed by another key', async () => {
    const { certificate } = await issueCertificate(claims, SECRET);
    const other = privateKeyToAccount(
      '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba'
    );
    const token = await mintAccessToken(certificate, { account: other });
    await expect(verifyAccessToken(token, SECRET)).rejects.toThrow(/agent key/);
  });

  it('rejects a certificate from another secret', async () => {
    const { certificate } = await issueCertificate(claims, 'some-other-secret');
    const token = await mintAccessToken(certificate);
    await expect(verifyAccessToken(token, SECRET)).rejects.toThrow(/Certificate/);
  });

  it('rejects a token for another wallet', async () => {
    const { certificate } = await issueCertificate(claims, SECRET);
    const token = await mintAccessToken(certificate, {
      wallet: '0x00000000000000000000000000000000000000bb'
    });
    await expect(verifyAccessToken(token, SECRET)).rejects.toThrow(/certificate/);
  });

  it('rejects expired and overlong tokens', async () => {
    const { certificate } = await issueCertificate(claims, SECRET);
    const old = await mintAccessToken(certificate, {
      iat: Math.floor(Date.now() / 1000) - 7200,
      ttl: 600
    });
    await expect(verifyAccessToken(old, SECRET)).rejects.toThrow(/expired/);
    const long = await mintAccessToken(certificate, { ttl: 7 * 24 * 3600 });
    await expect(verifyAccessToken(long, SECRET)).rejects.toThrow(/lifetime/);
  });

  it('rejects an expired certificate', async () => {
    const past = Math.floor(Date.now() / 1000) - 31 * 24 * 3600;
    const { certificate } = await issueCertificate(claims, SECRET, past);
    const token = await mintAccessToken(certificate);
    await expect(verifyAccessToken(token, SECRET)).rejects.toThrow(/certificate has expired/);
  });

  it('rejects a token for another audience', async () => {
    const { certificate } = await issueCertificate(claims, SECRET);
    const token = await mintAccessToken(certificate, { aud: 'elsewhere' });
    await expect(verifyAccessToken(token, SECRET)).rejects.toThrow(/another service/);
  });
});

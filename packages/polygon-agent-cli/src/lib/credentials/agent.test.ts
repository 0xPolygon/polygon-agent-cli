import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { recoverMessageAddress } from 'viem';
import { describe, expect, it } from 'vitest';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-credentials-'));
process.env.POLYGON_AGENT_LOGIN_UI = 'https://agentconnect.test';

const { enrollAgent, loadCertificate, mintAccessToken, ENROLL_PURPOSE } =
  await import('./agent.ts');

const WALLET = '0x00000000000000000000000000000000000000AA';
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const decode = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString());

// An owner whose ID token carries its claims in the clear, and a server that
// "verifies" it by reading them back.
function fixture(walletName: string, opts: { serverWallet?: string; status?: number } = {}) {
  const tokens: Record<string, unknown>[] = [];
  const owner = {
    walletAddress: WALLET,
    getIdToken: async (p: { customClaims?: Record<string, unknown> }) => {
      tokens.push(p.customClaims ?? {});
      return b64(p.customClaims);
    }
  };
  const now = Math.floor(Date.now() / 1000);
  const fetchImpl = (async (url: string, init: RequestInit) => {
    expect(url).toBe('https://agentconnect.test/api/agent/enroll');
    const claims = decode(JSON.parse(String(init.body)).idToken);
    if (opts.status)
      return new Response(JSON.stringify({ message: 'nope' }), { status: opts.status });
    return Response.json({
      certificate: `c1.${b64({ w: WALLET.toLowerCase(), k: claims.agent_key.toLowerCase() })}.mac`,
      wallet: (opts.serverWallet ?? WALLET).toLowerCase(),
      agentKey: claims.agent_key.toLowerCase(),
      expiresAt: now + 30 * 86400
    });
  }) as unknown as typeof fetch;
  return { owner, fetchImpl, tokens, walletName };
}

describe('enrollAgent', () => {
  it('trades an owner ID token for a certificate and stores it', async () => {
    const f = fixture('a');
    const res = await enrollAgent({
      wallet: 'a',
      owner: f.owner,
      walletAddress: WALLET,
      fetchImpl: f.fetchImpl
    });
    expect(res).toMatchObject({ enrolled: true, renewed: true });
    expect(f.tokens[0]).toMatchObject({ purpose: ENROLL_PURPOSE });
    expect(loadCertificate('a')?.wallet).toBe(WALLET.toLowerCase());
  });

  it('keeps a fresh certificate without asking OMS again', async () => {
    const f = fixture('b');
    await enrollAgent({
      wallet: 'b',
      owner: f.owner,
      walletAddress: WALLET,
      fetchImpl: f.fetchImpl
    });
    const again = await enrollAgent({
      wallet: 'b',
      owner: f.owner,
      walletAddress: WALLET,
      fetchImpl: f.fetchImpl
    });
    expect(again).toMatchObject({ enrolled: true, renewed: false });
    expect(f.tokens).toHaveLength(1);
  });

  it('re-enrolls when forced', async () => {
    const f = fixture('c');
    await enrollAgent({
      wallet: 'c',
      owner: f.owner,
      walletAddress: WALLET,
      fetchImpl: f.fetchImpl
    });
    await enrollAgent({
      wallet: 'c',
      owner: f.owner,
      walletAddress: WALLET,
      fetchImpl: f.fetchImpl,
      force: true
    });
    expect(f.tokens).toHaveLength(2);
  });

  it('refuses when the owner session is on another wallet', async () => {
    const f = fixture('d');
    const res = await enrollAgent({
      wallet: 'd',
      owner: { ...f.owner, walletAddress: '0x00000000000000000000000000000000000000bb' },
      walletAddress: WALLET,
      fetchImpl: f.fetchImpl
    });
    expect(res).toMatchObject({ enrolled: false });
    expect(f.tokens).toHaveLength(0);
  });

  it('never stores a certificate for another wallet', async () => {
    const f = fixture('e', { serverWallet: '0x00000000000000000000000000000000000000cc' });
    const res = await enrollAgent({
      wallet: 'e',
      owner: f.owner,
      walletAddress: WALLET,
      fetchImpl: f.fetchImpl
    });
    expect(res).toMatchObject({ enrolled: false });
    expect(loadCertificate('e')).toBeNull();
  });

  it('reports a server refusal without throwing', async () => {
    const f = fixture('f', { status: 401 });
    await expect(
      enrollAgent({ wallet: 'f', owner: f.owner, walletAddress: WALLET, fetchImpl: f.fetchImpl })
    ).resolves.toEqual({ enrolled: false, reason: 'nope' });
  });
});

describe('mintAccessToken', () => {
  it('is null before enrollment', async () => {
    expect(await mintAccessToken('never', 600)).toBeNull();
  });

  it('signs an at1 token with the agent key', async () => {
    const f = fixture('g');
    await enrollAgent({
      wallet: 'g',
      owner: f.owner,
      walletAddress: WALLET,
      fetchImpl: f.fetchImpl
    });
    const token = (await mintAccessToken('g', 600))!;
    const parts = token.split('.');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('at1');
    const claims = decode(parts[3]);
    expect(claims).toMatchObject({ w: WALLET.toLowerCase(), aud: 'agentconnect' });
    expect(claims.exp - claims.iat).toBe(600);
    const signer = await recoverMessageAddress({
      message: `agentconnect:${parts.slice(0, 4).join('.')}`,
      signature: parts[4] as `0x${string}`
    });
    expect(signer.toLowerCase()).toBe(loadCertificate('g')!.agentKey);
    expect(f.tokens[0].agent_key).toBe(signer);
  });
});

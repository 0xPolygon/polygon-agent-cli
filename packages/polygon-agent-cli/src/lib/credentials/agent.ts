// The agent's identity on agentconnect, for saved credentials (shipping
// address).
//
// Each wallet gets its own agent key. While the owner is signed in, the CLI
// asks OMS for an ID token naming that key and trades it at agentconnect for a
// 30-day certificate. After that the agent signs its own short-lived access
// tokens, offline: for its API calls, and in the fragment of dashboard links so
// the page can read and save credentials as this wallet.
//
// Token formats match packages/agentconnect-ui/worker/agent-auth.ts.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';

import { CliError } from '../errors.ts';
import { credentialsBaseUrl } from '../oms-client.ts';
import { decrypt, encrypt, STORAGE_ROOT } from '../storage.ts';

export const ENROLL_PURPOSE = 'agentconnect-enroll';
const AUDIENCE = 'agentconnect';
// Dashboard links are sent in chat and opened soon after; API calls are instant.
export const LINK_TOKEN_TTL_SECONDS = 60 * 60;
export const API_TOKEN_TTL_SECONDS = 5 * 60;
// Re-enroll at the next owner sign-in once less than this is left.
const RENEW_WITHIN_SECONDS = 7 * 24 * 60 * 60;

const KeyFile = z.object({ iv: z.string(), encrypted: z.string(), authTag: z.string() });
const CertFile = z.object({
  certificate: z.string(),
  wallet: z.string(),
  agentKey: z.string(),
  expiresAt: z.number()
});
export type StoredCertificate = z.infer<typeof CertFile>;

function dir(wallet: string): string {
  return path.join(STORAGE_ROOT, 'credentials', wallet);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function agentAccount(wallet: string, create: boolean) {
  const file = path.join(dir(wallet), 'key.json');
  const stored = KeyFile.safeParse(readJson(file));
  if (stored.success) return privateKeyToAccount(decrypt(stored.data) as `0x${string}`);
  if (!create) return null;
  const pk = toHex(randomBytes(32));
  writeJson(file, encrypt(pk));
  return privateKeyToAccount(pk);
}

// Certificates are only good at the deployment that issued them (staging,
// production, a local worker), so each host gets its own file.
function certFile(wallet: string): string {
  const host = new URL(credentialsBaseUrl()).host.replace(/[^\w.-]/g, '_');
  return path.join(dir(wallet), `certificate.${host}.json`);
}

export function loadCertificate(wallet: string, now = Date.now()): StoredCertificate | null {
  const parsed = CertFile.safeParse(readJson(certFile(wallet)));
  if (!parsed.success || parsed.data.expiresAt * 1000 <= now) return null;
  return parsed.data;
}

// What enrollment needs from the signed-in owner (OMSWallet's wallet client).
export interface OwnerIdTokenSource {
  walletAddress?: string;
  getIdToken(params: {
    ttlSeconds?: number;
    customClaims?: Record<string, unknown>;
  }): Promise<string>;
}

export type EnrollResult =
  | { enrolled: true; expiresAt: string; renewed: boolean }
  | { enrolled: false; reason: string };

/**
 * Enroll (or renew) this wallet's agent key while the owner is signed in.
 * Best effort and never throws: credentials are optional.
 */
export async function enrollAgent(p: {
  wallet: string;
  owner: OwnerIdTokenSource;
  walletAddress: string;
  force?: boolean;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<EnrollResult> {
  const now = p.now ?? Date.now();
  try {
    const existing = loadCertificate(p.wallet, now);
    const sameWallet = existing?.wallet === p.walletAddress.toLowerCase();
    if (
      !p.force &&
      existing &&
      sameWallet &&
      existing.expiresAt * 1000 - now > RENEW_WITHIN_SECONDS * 1000
    ) {
      return {
        enrolled: true,
        expiresAt: new Date(existing.expiresAt * 1000).toISOString(),
        renewed: false
      };
    }
    // The owner session may have switched to another OMS wallet (Polymarket keys);
    // the token must speak for the agent wallet.
    if (p.owner.walletAddress?.toLowerCase() !== p.walletAddress.toLowerCase()) {
      return { enrolled: false, reason: 'owner session is on another wallet' };
    }
    const account = agentAccount(p.wallet, true)!;
    const idToken = await p.owner.getIdToken({
      ttlSeconds: 120,
      customClaims: { agent_key: account.address, purpose: ENROLL_PURPOSE }
    });
    const res = await (p.fetchImpl ?? fetch)(`${credentialsBaseUrl()}/api/agent/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    });
    const body = (await res.json().catch(() => ({}))) as {
      certificate?: string;
      wallet?: string;
      agentKey?: string;
      expiresAt?: number;
      message?: string;
    };
    if (!res.ok || !body.certificate || !body.expiresAt) {
      return { enrolled: false, reason: body.message ?? `enroll failed (${res.status})` };
    }
    if (
      body.wallet !== p.walletAddress.toLowerCase() ||
      body.agentKey !== account.address.toLowerCase()
    ) {
      return { enrolled: false, reason: 'certificate does not match this wallet' };
    }
    writeJson(certFile(p.wallet), {
      certificate: body.certificate,
      wallet: body.wallet,
      agentKey: body.agentKey,
      expiresAt: body.expiresAt
    } satisfies StoredCertificate);
    return {
      enrolled: true,
      expiresAt: new Date(body.expiresAt * 1000).toISOString(),
      renewed: true
    };
  } catch (error) {
    return { enrolled: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function b64url(s: string): string {
  return Buffer.from(s).toString('base64url');
}

/** A signed access token for this wallet, or null when it isn't enrolled. */
export async function mintAccessToken(
  wallet: string,
  ttlSeconds: number,
  now = Date.now()
): Promise<string | null> {
  const cert = loadCertificate(wallet, now);
  const account = cert ? agentAccount(wallet, false) : null;
  if (!cert || !account || account.address.toLowerCase() !== cert.agentKey) return null;
  const [, certPayload, certMac] = cert.certificate.split('.');
  const iat = Math.floor(now / 1000);
  // Never past the certificate: the server would refuse it anyway.
  const exp = Math.min(iat + ttlSeconds, cert.expiresAt);
  const payload = b64url(
    JSON.stringify({ w: cert.wallet, k: cert.agentKey, iat, exp, aud: AUDIENCE })
  );
  const body = `at1.${certPayload}.${certMac}.${payload}`;
  const signature = await account.signMessage({ message: `agentconnect:${body}` });
  return `${body}.${signature}`;
}

export function notEnrolledError(wallet: string): CliError {
  return new CliError({
    code: 'credentials_not_linked',
    message: `Wallet '${wallet}' isn't linked for saved details yet. The owner links it by signing in once.`,
    command: `polygon-agent wallet link-credentials${wallet === 'main' ? '' : ` --name ${wallet}`}`
  });
}

/** Call the agentconnect credentials API as this wallet's agent. */
export async function credentialsApi<T>(
  wallet: string,
  method: 'GET' | 'PUT' | 'DELETE' | 'POST',
  apiPath: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch
): Promise<T> {
  const token = await mintAccessToken(wallet, API_TOKEN_TTL_SECONDS);
  if (!token) throw notEnrolledError(wallet);
  const res = await fetchImpl(`${credentialsBaseUrl()}${apiPath}`, {
    method,
    headers: {
      Authorization: `Agent ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) {
    // An expired or rejected certificate needs a fresh owner sign-in, same as never linked.
    if (res.status === 401) throw notEnrolledError(wallet);
    throw new CliError({
      code:
        res.status === 400
          ? 'invalid_input'
          : res.status === 503
            ? 'credentials_unavailable'
            : 'upstream_error',
      message: data.message ?? `Credentials request failed (${res.status})`
    });
  }
  return data;
}

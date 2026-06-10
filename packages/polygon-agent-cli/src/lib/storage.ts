import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { SessionPayload } from '@polygonlabs/agent-shared';

const STORAGE_DIR = path.join(os.homedir(), '.polygon-agent');
const ENCRYPTION_KEY_FILE = path.join(STORAGE_DIR, '.encryption-key');

export interface CipherData {
  iv: string;
  encrypted: string;
  authTag: string;
}

export interface BuilderConfig {
  privateKey: string;
  eoaAddress: string;
  accessKey: string;
  projectId: number;
}

/**
 * OMS (Sequence V3 "Open Money Stack") credentials for the typescript-sdk path.
 * publishableKey + omsProjectId come from the Sequence Builder dashboard.
 * Stored alongside builder.json so `wallet login` and tx submission can read them.
 */
export interface OmsConfig {
  publishableKey: string;
  omsProjectId: string;
}

/** Pointer record for an OMS wallet (the SDK persists the real session in its StorageManager). */
export interface OmsWalletPointer {
  walletAddress: string;
  loginMethod: 'email';
  email: string;
  createdAt: string;
}

export interface WalletSession {
  walletAddress: string;
  chainId: number;
  chain: string;
  projectAccessKey: string | null;
  explicitSession: string;
  sessionPk: string;
  sessionConfig?: string;
  implicitPk: string;
  implicitMeta: string;
  implicitAttestation: string;
  implicitIdentitySig: string;
  createdAt: string;
}

export function ensureStorageDir(): void {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 });
  }
  const subdirs = ['wallets', 'requests', 'state/dapp-client-cli'];
  for (const dir of subdirs) {
    const fullPath = path.join(STORAGE_DIR, dir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true, mode: 0o700 });
    }
  }
}

export const STORAGE_ROOT = STORAGE_DIR;

export function getEncryptionKey(): Buffer {
  ensureStorageDir();

  if (fs.existsSync(ENCRYPTION_KEY_FILE)) {
    return fs.readFileSync(ENCRYPTION_KEY_FILE);
  }

  const key = randomBytes(32);
  fs.writeFileSync(ENCRYPTION_KEY_FILE, key, { mode: 0o600 });
  return key;
}

export function encrypt(plaintext: string): CipherData {
  const key = getEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('hex'),
    encrypted,
    authTag: authTag.toString('hex')
  };
}

export function decrypt(cipherData: CipherData): string {
  const key = getEncryptionKey();
  const iv = Buffer.from(cipherData.iv, 'hex');
  const authTag = Buffer.from(cipherData.authTag, 'hex');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(cipherData.encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

export async function saveBuilderConfig(config: BuilderConfig): Promise<void> {
  ensureStorageDir();

  const configPath = path.join(STORAGE_DIR, 'builder.json');
  const encryptedKey = encrypt(config.privateKey);

  const data = {
    privateKey: encryptedKey,
    eoaAddress: config.eoaAddress,
    accessKey: config.accessKey,
    projectId: config.projectId
  };

  fs.writeFileSync(configPath, JSON.stringify(data, null, 2), {
    mode: 0o600
  });
}

export async function loadBuilderConfig(): Promise<BuilderConfig | null> {
  const configPath = path.join(STORAGE_DIR, 'builder.json');

  if (!fs.existsSync(configPath)) {
    return null;
  }

  const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const privateKey = decrypt(data.privateKey);

  return {
    privateKey,
    eoaAddress: data.eoaAddress,
    accessKey: data.accessKey,
    projectId: data.projectId
  };
}

/**
 * Synchronously resolve the project access key.
 * Priority: env var → wallet session's stored key → builder.json on disk.
 * Returns undefined if none found.
 */
export function resolveAccessKeySync(sessionKey?: string | null): string | undefined {
  if (process.env.SEQUENCE_PROJECT_ACCESS_KEY) return process.env.SEQUENCE_PROJECT_ACCESS_KEY;
  if (process.env.SEQUENCE_INDEXER_ACCESS_KEY) return process.env.SEQUENCE_INDEXER_ACCESS_KEY;
  if (sessionKey) return sessionKey;
  const configPath = path.join(STORAGE_DIR, 'builder.json');
  if (fs.existsSync(configPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (data.accessKey) return data.accessKey as string;
    } catch {
      // ignore malformed config
    }
  }
  return undefined;
}

/**
 * Bootstrap: populate SEQUENCE_PROJECT_ACCESS_KEY from builder.json if not already set.
 * Call once at CLI startup so all commands can rely on the env var being present.
 */
export function bootstrapAccessKey(): void {
  const key = resolveAccessKeySync();
  if (key && !process.env.SEQUENCE_PROJECT_ACCESS_KEY) {
    process.env.SEQUENCE_PROJECT_ACCESS_KEY = key;
  }
  if (key && !process.env.SEQUENCE_INDEXER_ACCESS_KEY) {
    process.env.SEQUENCE_INDEXER_ACCESS_KEY = key;
  }
}

export async function saveWalletSession(name: string, session: WalletSession): Promise<void> {
  ensureStorageDir();

  const walletPath = path.join(STORAGE_DIR, 'wallets', `${name}.json`);
  fs.writeFileSync(walletPath, JSON.stringify(session, null, 2), {
    mode: 0o600
  });
}

export async function loadWalletSession(name: string): Promise<WalletSession | null> {
  const walletPath = path.join(STORAGE_DIR, 'wallets', `${name}.json`);

  if (!fs.existsSync(walletPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(walletPath, 'utf8'));
}

export interface WalletRequest {
  rid: string;
  walletName: string;
  chain: string;
  createdAt: string;
  expiresAt: string;
  publicKeyB64u: string;
  privateKeyB64u: string;
  projectAccessKey: string | null;
  /** v2: X25519 secret key hex (used with relay-based code flow) */
  cliSkHex?: string;
}

export async function saveWalletRequest(rid: string, request: WalletRequest): Promise<void> {
  ensureStorageDir();

  // cliSkHex (v2 X25519 secret key) is stored as plaintext here intentionally:
  // the file has 0o600 permissions and the key is ephemeral — it is only useful
  // during the ~5-minute request window and is deleted after successful import.
  const requestPath = path.join(STORAGE_DIR, 'requests', `${rid}.json`);
  fs.writeFileSync(requestPath, JSON.stringify(request, null, 2), {
    mode: 0o600
  });
}

export async function loadWalletRequest(rid: string): Promise<WalletRequest | null> {
  const requestPath = path.join(STORAGE_DIR, 'requests', `${rid}.json`);

  if (!fs.existsSync(requestPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(requestPath, 'utf8'));
}

export async function deleteWalletRequest(rid: string): Promise<void> {
  const requestPath = path.join(STORAGE_DIR, 'requests', `${rid}.json`);
  if (fs.existsSync(requestPath)) {
    fs.unlinkSync(requestPath);
  }
}

export async function listWallets(): Promise<string[]> {
  ensureStorageDir();

  const walletsDir = path.join(STORAGE_DIR, 'wallets');
  const files = fs.readdirSync(walletsDir);

  return files.filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
}

export async function deleteWallet(name: string): Promise<boolean> {
  const walletPath = path.join(STORAGE_DIR, 'wallets', `${name}.json`);

  if (fs.existsSync(walletPath)) {
    fs.unlinkSync(walletPath);
    return true;
  }

  return false;
}

export async function savePolymarketKey(privateKey: string): Promise<void> {
  ensureStorageDir();
  const configPath = path.join(STORAGE_DIR, 'builder.json');
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // File doesn't exist yet — start with empty object
  }
  data.polymarketPrivateKey = encrypt(privateKey);
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export async function loadPolymarketKey(): Promise<string> {
  const configPath = path.join(STORAGE_DIR, 'builder.json');
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    throw new Error('No builder config found. Run: polygon-agent setup');
  }
  if (data.polymarketPrivateKey) return decrypt(data.polymarketPrivateKey as CipherData);
  if (data.privateKey) return decrypt(data.privateKey as CipherData);
  throw new Error(
    'No EOA key found. Run: polygon-agent setup or polygon-agent polymarket set-key <privateKey>'
  );
}

// ─── OMS (Sequence V3 / typescript-sdk) config + session storage ──────────────

/** Directory holding the OMS SDK's per-wallet storage + credential key. */
export function omsWalletDir(name: string): string {
  ensureStorageDir();
  const dir = path.join(STORAGE_DIR, 'oms', name);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

/** Persist OMS publishableKey + projectId into builder.json (merged with existing data). */
export async function saveOmsConfig(config: OmsConfig): Promise<void> {
  ensureStorageDir();
  const configPath = path.join(STORAGE_DIR, 'builder.json');
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // start fresh
  }
  data.publishableKey = config.publishableKey;
  data.omsProjectId = config.omsProjectId;
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Resolve OMS credentials. Priority: env vars → builder.json.
 * Returns null if neither key is available.
 */
export function loadOmsConfig(): OmsConfig | null {
  const envPk = process.env.SEQUENCE_PUBLISHABLE_KEY;
  const envProj = process.env.SEQUENCE_OMS_PROJECT_ID;
  if (envPk && envProj) return { publishableKey: envPk, omsProjectId: envProj };

  const configPath = path.join(STORAGE_DIR, 'builder.json');
  if (fs.existsSync(configPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const publishableKey = envPk ?? data.publishableKey;
      const omsProjectId = envProj ?? data.omsProjectId;
      if (publishableKey && omsProjectId) return { publishableKey, omsProjectId };
    } catch {
      // ignore malformed config
    }
  }
  return null;
}

/** Populate OMS env vars from builder.json at startup (mirrors bootstrapAccessKey). */
export function bootstrapOmsConfig(): void {
  const cfg = loadOmsConfig();
  if (!cfg) return;
  if (!process.env.SEQUENCE_PUBLISHABLE_KEY)
    process.env.SEQUENCE_PUBLISHABLE_KEY = cfg.publishableKey;
  if (!process.env.SEQUENCE_OMS_PROJECT_ID) process.env.SEQUENCE_OMS_PROJECT_ID = cfg.omsProjectId;
}

export async function saveOmsWalletPointer(name: string, pointer: OmsWalletPointer): Promise<void> {
  ensureStorageDir();
  const walletPath = path.join(STORAGE_DIR, 'wallets', `${name}.json`);
  fs.writeFileSync(walletPath, JSON.stringify(pointer, null, 2), { mode: 0o600 });
}

export async function loadOmsWalletPointer(name: string): Promise<OmsWalletPointer | null> {
  const walletPath = path.join(STORAGE_DIR, 'wallets', `${name}.json`);
  if (!fs.existsSync(walletPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
    if (data.loginMethod === 'email' && data.walletAddress) return data as OmsWalletPointer;
  } catch {
    // not an OMS pointer (likely a legacy WalletSession)
  }
  return null;
}

/** Remove an OMS wallet's pointer + the SDK's per-wallet state dir. */
export async function deleteOmsWallet(name: string): Promise<void> {
  const walletPath = path.join(STORAGE_DIR, 'wallets', `${name}.json`);
  if (fs.existsSync(walletPath)) fs.unlinkSync(walletPath);
  const dir = path.join(STORAGE_DIR, 'oms', name);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/** Map a v2 SessionPayload into the WalletSession shape. */
export function sessionPayloadToWalletSession(payload: SessionPayload): WalletSession {
  const chainName = resolveChainNameFromId(payload.chain_id);
  const implicit = payload.implicit_session;

  const implicitMeta = {
    guard: implicit?.guard,
    loginMethod: implicit?.login_method,
    userEmail: implicit?.user_email
  };

  return {
    walletAddress: payload.wallet_address,
    chainId: payload.chain_id,
    chain: chainName,
    projectAccessKey: payload.project_access_key ?? null,
    explicitSession: JSON.stringify({ pk: payload.session_private_key }),
    sessionPk: payload.session_private_key,
    sessionConfig: payload.session_config ?? undefined,
    implicitPk: implicit?.pk ?? '',
    implicitMeta: JSON.stringify(implicitMeta),
    implicitAttestation: implicit?.attestation ?? '',
    implicitIdentitySig: implicit?.identity_sig ? JSON.stringify(implicit.identity_sig) : '',
    createdAt: new Date().toISOString()
  };
}

/** Map numeric chainId to chain name string (e.g. 137 → "polygon"). */
function resolveChainNameFromId(chainId: number): string {
  const map: Record<number, string> = {
    137: 'polygon',
    80002: 'polygon-amoy',
    42161: 'arbitrum',
    10: 'optimism',
    8453: 'base',
    1: 'mainnet'
  };
  return map[chainId] ?? String(chainId);
}

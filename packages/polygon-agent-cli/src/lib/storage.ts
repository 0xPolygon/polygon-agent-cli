import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { SessionPayload } from '@polygonlabs/agent-shared';

const STORAGE_DIR = path.join(os.homedir(), '.polygon-agent');
const ENCRYPTION_KEY_FILE = path.join(STORAGE_DIR, '.encryption-key');

interface CipherData {
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

function ensureStorageDir(): void {
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

function getEncryptionKey(): Buffer {
  ensureStorageDir();

  if (fs.existsSync(ENCRYPTION_KEY_FILE)) {
    return fs.readFileSync(ENCRYPTION_KEY_FILE);
  }

  const key = randomBytes(32);
  fs.writeFileSync(ENCRYPTION_KEY_FILE, key, { mode: 0o600 });
  return key;
}

function encrypt(plaintext: string): CipherData {
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

function decrypt(cipherData: CipherData): string {
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

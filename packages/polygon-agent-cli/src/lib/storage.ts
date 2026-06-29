import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
 * As of SDK 0.1.0-alpha.4 the publishableKey alone identifies the project;
 * omsProjectId is retained as optional for backward compat / display only.
 * Stored alongside builder.json so `wallet login` and tx submission can read it.
 */
export interface OmsConfig {
  publishableKey: string;
  omsProjectId?: string;
}

/** Pointer record for an OMS wallet (the SDK persists the real session in its StorageManager). */
export interface OmsWalletPointer {
  walletAddress: string;
  loginMethod: 'email';
  email: string;
  createdAt: string;
}

export function ensureStorageDir(): void {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 });
  }
  const subdirs = ['wallets', 'oms'];
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
  // SDK 0.1.0-alpha.4: only the publishableKey is required (it identifies the
  // project). omsProjectId is read if present but no longer mandatory.
  const envPk = process.env.SEQUENCE_PUBLISHABLE_KEY;
  const envProj = process.env.SEQUENCE_OMS_PROJECT_ID;
  if (envPk) return { publishableKey: envPk, omsProjectId: envProj };

  const configPath = path.join(STORAGE_DIR, 'builder.json');
  if (fs.existsSync(configPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const publishableKey = data.publishableKey;
      if (publishableKey) return { publishableKey, omsProjectId: data.omsProjectId };
    } catch {
      // ignore malformed config
    }
  }
  return null;
}

/** Populate OMS env vars from builder.json at startup. */
export function bootstrapOmsConfig(): void {
  const cfg = loadOmsConfig();
  if (cfg) {
    if (!process.env.SEQUENCE_PUBLISHABLE_KEY)
      process.env.SEQUENCE_PUBLISHABLE_KEY = cfg.publishableKey;
    if (!process.env.SEQUENCE_OMS_PROJECT_ID && cfg.omsProjectId)
      process.env.SEQUENCE_OMS_PROJECT_ID = cfg.omsProjectId;
  }

  // Also bootstrap the Sequence project access key (used by Trails swap/bridge
  // and the indexer) from builder.json into the env, if present — env always
  // wins. This is separate from the OMS wallet credentials above.
  if (!process.env.SEQUENCE_PROJECT_ACCESS_KEY) {
    const configPath = path.join(STORAGE_DIR, 'builder.json');
    if (fs.existsSync(configPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (data.accessKey) process.env.SEQUENCE_PROJECT_ACCESS_KEY = data.accessKey as string;
      } catch {
        // ignore malformed config
      }
    }
  }
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
    // not a valid OMS pointer file
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

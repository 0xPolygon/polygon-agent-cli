import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
}

export async function saveWalletRequest(rid: string, request: WalletRequest): Promise<void> {
  ensureStorageDir();

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

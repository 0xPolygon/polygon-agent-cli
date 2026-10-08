import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { CliError } from './errors.ts';

// A workspace install's wrapper sets POLYGON_AGENT_HOME to its own state folder;
// a global install keeps using ~/.polygon-agent.
const STORAGE_DIR = process.env.POLYGON_AGENT_HOME
  ? path.resolve(process.env.POLYGON_AGENT_HOME)
  : path.join(os.homedir(), '.polygon-agent');
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
 * OMS (Open Money Stack) V3 credentials for the typescript-sdk path.
 * As of SDK 0.1.0-alpha.4 the publishableKey alone identifies the project;
 * omsProjectId is retained as optional for backward compat / display only.
 * Stored alongside builder.json so `wallet login` and tx submission can read it.
 */
export interface OmsConfig {
  publishableKey: string;
  omsProjectId?: string;
}

/** How a wallet session was established: Google or email, both chosen on the browser login page. */
export type OmsLoginMethod = 'google' | 'email';

/**
 * Pointer record for an OMS wallet (the SDK persists the real session in its
 * StorageManager). `access: 'session'` marks a wallet this install spends from
 * through smart sessions (lib/session/); absent means owner mode.
 */
export interface OmsWalletPointer {
  walletAddress: string;
  loginMethod: OmsLoginMethod;
  createdAt: string;
  access?: 'owner' | 'session';
  email?: string;
  installName?: string;
}

const OmsWalletPointerSchema = z.object({
  walletAddress: z.string().min(1),
  // Any string, as before: legacy values load and display as 'email'.
  loginMethod: z
    .string()
    .transform((value): OmsLoginMethod => (value === 'google' ? 'google' : 'email')),
  createdAt: z.string(),
  access: z.enum(['owner', 'session']).optional(),
  email: z.string().optional(),
  installName: z.string().optional()
});

// Wallet names become file and folder names (wallets/<name>.json, oms/<name>/,
// session/<name>/, pending/<name>.json, their locks), some of which are
// deleted recursively, so a name must never be able to leave its folder.
const WALLET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function walletName(name: string): string {
  if (!WALLET_NAME.test(name)) {
    throw new CliError({
      code: 'invalid_input',
      message: `Invalid wallet name ${JSON.stringify(name)}: use up to 64 letters, digits, '.', '-' and '_', starting with a letter or digit.`
    });
  }
  return name;
}

export function ensureStorageDir(): void {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 });
  }
  // Owner-only, even when something else created the folder first (only a
  // folder this user owns; one shared on purpose is left as it is).
  const stat = fs.statSync(STORAGE_DIR);
  if ((stat.mode & 0o777) !== 0o700 && stat.uid === process.getuid?.()) {
    try {
      fs.chmodSync(STORAGE_DIR, 0o700);
    } catch {
      // a filesystem without permissions
    }
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

// Created once, complete or not at all: written to a temp file, then linked
// into place, which fails if another run got there first (both then use the
// winner's key, never one each).
export function getEncryptionKey(): Buffer {
  ensureStorageDir();
  if (!fs.existsSync(ENCRYPTION_KEY_FILE)) {
    const key = randomBytes(32);
    const tmp = `${ENCRYPTION_KEY_FILE}.tmp-${process.pid}`;
    const code = (error: unknown) =>
      error instanceof Error && 'code' in error ? error.code : undefined;
    try {
      fs.writeFileSync(tmp, key, { mode: 0o600 });
      try {
        fs.linkSync(tmp, ENCRYPTION_KEY_FILE);
      } catch (error) {
        // No hard links here (FAT, some network or container mounts): an
        // exclusive create instead; a torn one fails the length check below.
        if (code(error) === 'EEXIST') throw error;
        fs.writeFileSync(ENCRYPTION_KEY_FILE, key, { mode: 0o600, flag: 'wx' });
      }
    } catch (error) {
      if (code(error) !== 'EEXIST') throw error;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  const key = fs.readFileSync(ENCRYPTION_KEY_FILE);
  if (key.length !== 32) {
    throw new Error(`The encryption key file ${ENCRYPTION_KEY_FILE} is damaged.`);
  }
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

  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // File doesn't exist yet, or is unreadable. Start fresh.
  }

  data.privateKey = encryptedKey;
  data.eoaAddress = config.eoaAddress;
  data.accessKey = config.accessKey;
  data.projectId = config.projectId;

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
 * Read builder.json's accessKey without decrypting the privateKey blob.
 * The provisioning short-circuit must honor an existing project even when
 * the encrypted privateKey blob is unreadable (e.g. a stale or missing
 * encryption key). This reads only the plaintext accessKey field.
 */
export function loadBuilderConfigRaw(): { accessKey?: string } | null {
  const configPath = path.join(STORAGE_DIR, 'builder.json');

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return { accessKey: data.accessKey };
  } catch {
    return null;
  }
}

export async function listWallets(): Promise<string[]> {
  ensureStorageDir();

  const walletsDir = path.join(STORAGE_DIR, 'wallets');
  const files = fs.readdirSync(walletsDir);

  // A file whose name isn't a valid wallet name (from before names were
  // checked) is skipped: no command can use it, and it must not break those
  // that list wallets.
  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter((name) => WALLET_NAME.test(name));
}

export async function deleteWallet(name: string): Promise<boolean> {
  const walletPath = path.join(STORAGE_DIR, 'wallets', `${walletName(name)}.json`);

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
    throw new Error('No builder config found. Run: agent setup');
  }
  if (data.polymarketPrivateKey) return decrypt(data.polymarketPrivateKey as CipherData);
  if (data.privateKey) return decrypt(data.privateKey as CipherData);
  throw new Error('No EOA key found. Run: agent setup or agent polymarket set-key <privateKey>');
}

// ─── OMS (Open Money Stack V3 / typescript-sdk) config + session storage ──────

/** Directory holding the OMS SDK's per-wallet storage + credential key. */
export function omsWalletDir(name: string): string {
  ensureStorageDir();
  const dir = path.join(STORAGE_DIR, 'oms', walletName(name));
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

// Default OMS publishable key so `wallet login` works with zero setup.
// Publishable keys are client-embeddable by design; users are wallets inside
// the CLI's shared OMS project. This is the intended production project key
// (the sdbx prefix is just how the project's keys are labeled). Override with
// OMS_PUBLISHABLE_KEY or `setup --oms-publishable-key`.
export const DEFAULT_OMS_PUBLISHABLE_KEY = 'pk_sdbx_01kqfw9zaykks_01kwvkkzs5e2wb6rfas2y2njm8';

/**
 * Resolve OMS credentials. Priority: env vars → builder.json → baked-in default.
 */
export function loadOmsConfig(): OmsConfig {
  // SDK 0.1.0-alpha.4: only the publishableKey is required (it identifies the
  // project). omsProjectId is read if present but no longer mandatory.
  const envPk = process.env.OMS_PUBLISHABLE_KEY;
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
  return { publishableKey: DEFAULT_OMS_PUBLISHABLE_KEY, omsProjectId: envProj };
}

/** Populate OMS env vars from builder.json at startup. */
export function bootstrapOmsConfig(): void {
  const cfg = loadOmsConfig();
  if (!process.env.OMS_PUBLISHABLE_KEY) process.env.OMS_PUBLISHABLE_KEY = cfg.publishableKey;
  if (!process.env.SEQUENCE_OMS_PROJECT_ID && cfg.omsProjectId)
    process.env.SEQUENCE_OMS_PROJECT_ID = cfg.omsProjectId;

  // Also bootstrap the OMS project access key (used by Trails swap/bridge
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
  const walletPath = path.join(STORAGE_DIR, 'wallets', `${walletName(name)}.json`);
  fs.writeFileSync(walletPath, JSON.stringify(pointer, null, 2), { mode: 0o600 });
}

export async function loadOmsWalletPointer(name: string): Promise<OmsWalletPointer | null> {
  const walletPath = path.join(STORAGE_DIR, 'wallets', `${walletName(name)}.json`);
  if (!fs.existsSync(walletPath)) return null;
  try {
    // loginMethod is display-only; legacy pre-browser sessions still load until
    // they expire.
    const parsed = OmsWalletPointerSchema.safeParse(
      JSON.parse(fs.readFileSync(walletPath, 'utf8'))
    );
    if (parsed.success) return parsed.data;
  } catch {
    // not a valid OMS pointer file
  }
  return null;
}

/** Remove an OMS wallet's pointer + the SDK's per-wallet state dir. */
export async function deleteOmsWallet(name: string): Promise<void> {
  const walletPath = path.join(STORAGE_DIR, 'wallets', `${walletName(name)}.json`);
  if (fs.existsSync(walletPath)) fs.unlinkSync(walletPath);
  const dir = path.join(STORAGE_DIR, 'oms', walletName(name));
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

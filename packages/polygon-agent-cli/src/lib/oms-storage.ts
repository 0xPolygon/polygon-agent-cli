// File-backed StorageManager + credential-key persistence for the OMS SDK.
//
// The OMS typescript-sdk persists its wallet session through a StorageManager
// (a simple get/set/delete string KV) and signs requests with a CredentialSigner.
// For a headless CLI we:
//   - back the StorageManager with encrypted files under ~/.polygon-agent/oms/<name>/store/
//   - persist the EthereumPrivateKeyCredentialSigner's private key to disk (encrypted)
// so a session survives across CLI invocations (verified in the Phase 0 spike).

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { StorageManager } from '@0xsequence/typescript-sdk';

import type { CipherData } from './storage.ts';

import { decrypt, encrypt, omsWalletDir } from './storage.ts';

// Encode a storage key into a filesystem-safe filename.
function keyToFile(dir: string, key: string): string {
  const safe = Buffer.from(key).toString('hex');
  return path.join(dir, `${safe}.enc`);
}

/**
 * Synchronous, encrypted, file-backed StorageManager scoped to one wallet name.
 * Each entry is an AES-256-GCM blob written under <omsWalletDir>/<subdir>/.
 * `subdir` defaults to 'store' (the session store); the OIDC redirect flow uses
 * a separate 'redirect-store' so its transient pending state stays isolated.
 */
export class FileStorageManager implements StorageManager {
  private dir: string;

  constructor(walletName: string, subdir = 'store') {
    this.dir = path.join(omsWalletDir(walletName), subdir);
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  get(key: string): string | null {
    const file = keyToFile(this.dir, key);
    if (!fs.existsSync(file)) return null;
    try {
      const cipher = JSON.parse(fs.readFileSync(file, 'utf8')) as CipherData;
      return decrypt(cipher);
    } catch {
      return null;
    }
  }

  set(key: string, value: string): void {
    const file = keyToFile(this.dir, key);
    fs.writeFileSync(file, JSON.stringify(encrypt(value)), { mode: 0o600 });
  }

  delete(key: string): void {
    const file = keyToFile(this.dir, key);
    // Unlink directly and ignore "already gone" rather than check-then-delete.
    try {
      fs.unlinkSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

const CREDENTIAL_KEY_FILE = 'credential.key.enc';

/**
 * Load the persisted credential private key for a wallet, or generate + persist
 * a new one. Returns the raw 32-byte key for EthereumPrivateKeyCredentialSigner.
 */
export function loadOrCreateCredentialKey(walletName: string): Uint8Array {
  const file = path.join(omsWalletDir(walletName), CREDENTIAL_KEY_FILE);
  // Read-or-create without a check-then-use race: try to read; on ENOENT create
  // the file exclusively (wx), and if a concurrent run won that race, loop back
  // and read the key it wrote.
  for (;;) {
    try {
      const cipher = JSON.parse(fs.readFileSync(file, 'utf8')) as CipherData;
      return Uint8Array.from(Buffer.from(decrypt(cipher), 'hex'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const keyHex = Buffer.from(randomBytes(32)).toString('hex');
    try {
      fs.writeFileSync(file, JSON.stringify(encrypt(keyHex)), { mode: 0o600, flag: 'wx' });
      return Uint8Array.from(Buffer.from(keyHex, 'hex'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

/** True if a credential key has already been persisted for this wallet. */
export function hasCredentialKey(walletName: string): boolean {
  return fs.existsSync(path.join(omsWalletDir(walletName), CREDENTIAL_KEY_FILE));
}

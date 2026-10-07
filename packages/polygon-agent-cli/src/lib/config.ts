// config.json in the state folder: small, unencrypted CLI settings (the tx mode,
// the cached latest CLI version). Unknown keys are preserved on every write.

import fs from 'node:fs';
import path from 'node:path';

import { ensureStorageDir, STORAGE_ROOT } from './storage.ts';

function configPath(): string {
  return path.join(STORAGE_ROOT, 'config.json');
}

export function readConfig(): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? { ...data } : {};
  } catch {
    return {};
  }
}

export function updateConfig(patch: Record<string, unknown>): void {
  ensureStorageDir();
  const data = { ...readConfig(), ...patch };
  fs.writeFileSync(configPath(), JSON.stringify(data, null, 2), { mode: 0o600 });
}

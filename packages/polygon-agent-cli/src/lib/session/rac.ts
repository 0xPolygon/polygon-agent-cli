// The install's session key: a remote access credential (RAC) the owner
// authorizes smart sessions for. 'rac' is the live key; 'rac-next' exists only
// while a renewal is pending (a key's lifetime can't be extended).

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { RemoteAccessClient } from '@polygonlabs/oms-wallet';

import { decrypt, encrypt, loadOmsConfig } from '../storage.ts';
import { PersistentNonceSigner } from './rac-signer.ts';
import { readJsonFile, sessionDir, writeJsonFile } from './state.ts';

export type RacSlot = 'rac' | 'rac-next';

const APP_URL = 'https://agents.polygon.technology';
// Served by agentconnect-ui (public/polygon-logo.png).
const APP_LOGO_URL = 'https://agentconnect.polygon.technology/polygon-logo.png';
// The key outlives the sessions slightly, so a session never outlives its key.
const LIFETIME_MARGIN_SECONDS = 24 * 60 * 60;

const RacRecordSchema = z.object({
  credentialId: z.string(),
  registeredAt: z.string(),
  expiresAt: z.string(),
  installName: z.string()
});
export type RacRecord = z.infer<typeof RacRecordSchema>;

const CipherSchema = z.object({ iv: z.string(), encrypted: z.string(), authTag: z.string() });

function slotFile(params: { wallet: string; slot: RacSlot; suffix: string }): string {
  return path.join(sessionDir(params.wallet), `${params.slot}.${params.suffix}`);
}

// Reads the slot's key, or creates it exclusively (a concurrent creator wins
// and we read its key).
export function loadOrCreateRacKey(params: { wallet: string; slot: RacSlot }): Uint8Array {
  const file = slotFile({ ...params, suffix: 'key.enc' });
  for (;;) {
    const cipher = CipherSchema.safeParse(readJsonFile(file));
    if (cipher.success) return Buffer.from(decrypt(cipher.data), 'hex');
    const key = randomBytes(32);
    try {
      fs.writeFileSync(file, JSON.stringify(encrypt(key.toString('hex'))), {
        flag: 'wx',
        mode: 0o600
      });
      return key;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
  }
}

export function readRacRecord(params: { wallet: string; slot: RacSlot }): RacRecord | null {
  const parsed = RacRecordSchema.safeParse(readJsonFile(slotFile({ ...params, suffix: 'json' })));
  return parsed.success ? parsed.data : null;
}

export function racClient(params: { wallet: string; slot: RacSlot }): RemoteAccessClient {
  return new RemoteAccessClient({
    publishableKey: loadOmsConfig().publishableKey,
    credentialSigner: new PersistentNonceSigner({
      privateKey: loadOrCreateRacKey(params),
      nonceFile: slotFile({ ...params, suffix: 'nonce.json' })
    })
  });
}

// Registers the slot's key with OMS for `days` (plus a margin) and records it.
// A slot already registered for long enough is reused.
export async function registerRac(params: {
  wallet: string;
  slot: RacSlot;
  days: number;
  installName: string;
  version: string;
  now: Date;
}): Promise<RacRecord> {
  const existing = readRacRecord(params);
  const neededUntil = params.now.getTime() + params.days * 86_400_000;
  if (existing && Date.parse(existing.expiresAt) > neededUntil) return existing;
  if (existing) {
    // Too short-lived to reuse: retire it on OMS too, not just locally.
    await racClient(params)
      .revokeCredential({ credentialId: existing.credentialId })
      .catch(() => undefined);
    clearRacSlot(params);
  }

  const lifetimeSeconds = params.days * 86_400 + LIFETIME_MARGIN_SECONDS;
  const { credentialId } = await racClient(params).registerCredential({
    lifetimeSeconds,
    metadata: {
      appName: `Polygon OMS Agent Kit (${params.installName})`,
      appUrl: APP_URL,
      appLogoUrl: APP_LOGO_URL,
      custom: { app: 'polygon-agent-cli', install: params.installName, version: params.version }
    }
  });
  const record: RacRecord = {
    credentialId,
    registeredAt: params.now.toISOString(),
    expiresAt: new Date(params.now.getTime() + lifetimeSeconds * 1000).toISOString(),
    installName: params.installName
  };
  writeJsonFile({ file: slotFile({ ...params, suffix: 'json' }), data: record });
  return record;
}

export function clearRacSlot(params: { wallet: string; slot: RacSlot }): void {
  for (const suffix of ['key.enc', 'json', 'nonce.json']) {
    fs.rmSync(slotFile({ ...params, suffix }), { force: true });
  }
}

// After a renewal: the new key becomes the live one.
export function promoteNextRac(wallet: string): void {
  clearRacSlot({ wallet, slot: 'rac' });
  for (const suffix of ['key.enc', 'json', 'nonce.json']) {
    const from = slotFile({ wallet, slot: 'rac-next', suffix });
    if (fs.existsSync(from)) fs.renameSync(from, slotFile({ wallet, slot: 'rac', suffix }));
  }
}

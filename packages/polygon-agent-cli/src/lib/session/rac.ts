// The install's session key: a remote access credential (RAC) the owner
// authorizes smart sessions for. 'rac' is the live key; 'rac-next' exists only
// while a renewal is pending (a key's lifetime can't be extended). A replaced
// key is parked as 'retiring-<credentialId>' until OMS confirms it is revoked,
// so a failed revoke is retried instead of leaving access nobody tracks.
//
// Each slot is a directory (keys/<slot>/ with key.enc, record.json and
// nonce.json), so promoting or parking a key is one atomic rename: moving a key
// never separates it from its record. (A crash while registering can leave a
// key without a record; it has no sessions, since those need the record.)

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import type { OMSWallet } from '@polygonlabs/oms-wallet';

import { RemoteAccessClient } from '@polygonlabs/oms-wallet';

import { CliError, httpStatus } from '../errors.ts';
import { decrypt, encrypt, loadOmsConfig } from '../storage.ts';
import { PersistentNonceSigner } from './rac-signer.ts';
import { readJsonFile, sessionDir, writeJsonFile } from './state.ts';

export type RacSlot = 'rac' | 'rac-next' | `retiring-${string}`;

const PARKED = /^retiring-[\w-]+$/;

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

function keysDir(wallet: string): string {
  return path.join(sessionDir(wallet), 'keys');
}

function slotDir(params: { wallet: string; slot: RacSlot }): string {
  return path.join(keysDir(params.wallet), params.slot);
}

function slotFile(params: {
  wallet: string;
  slot: RacSlot;
  name: 'key.enc' | 'record.json' | 'nonce.json';
}): string {
  return path.join(slotDir(params), params.name);
}

// Reads the slot's key, or creates it exclusively (a concurrent creator wins
// and we read its key).
export function loadOrCreateRacKey(params: { wallet: string; slot: RacSlot }): Uint8Array {
  fs.mkdirSync(slotDir(params), { recursive: true, mode: 0o700 });
  const file = slotFile({ ...params, name: 'key.enc' });
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

// The slot's existing key. Never creates one: a missing key (e.g. a move cut
// short by a crash) must not be replaced by a new key that OMS would answer
// with 401, which would read as "already revoked".
function loadRacKey(params: { wallet: string; slot: RacSlot }): Uint8Array {
  const cipher = CipherSchema.safeParse(readJsonFile(slotFile({ ...params, name: 'key.enc' })));
  if (!cipher.success) {
    throw new CliError({
      code: 'not_connected',
      message: `This install's session key (${params.slot}) is missing.`,
      hint: 'Connect again with a new email code.',
      command: 'polygon-agent wallet login --email <email>'
    });
  }
  return Buffer.from(decrypt(cipher.data), 'hex');
}

export function hasRacKey(params: { wallet: string; slot: RacSlot }): boolean {
  return fs.existsSync(slotFile({ ...params, name: 'key.enc' }));
}

export function readRacRecord(params: { wallet: string; slot: RacSlot }): RacRecord | null {
  const parsed = RacRecordSchema.safeParse(
    readJsonFile(slotFile({ ...params, name: 'record.json' }))
  );
  return parsed.success ? parsed.data : null;
}

export function racClient(params: { wallet: string; slot: RacSlot }): RemoteAccessClient {
  return new RemoteAccessClient({
    publishableKey: loadOmsConfig().publishableKey,
    credentialSigner: new PersistentNonceSigner({
      privateKey: loadRacKey(params),
      nonceFile: slotFile({ ...params, name: 'nonce.json' })
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
  // Too short-lived to reuse: retire it on OMS too, not just locally.
  if (existing) await retireRac(params);

  const lifetimeSeconds = params.days * 86_400 + LIFETIME_MARGIN_SECONDS;
  loadOrCreateRacKey(params);
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
  writeJsonFile({ file: slotFile({ ...params, name: 'record.json' }), data: record });
  return record;
}

export function clearRacSlot(params: { wallet: string; slot: RacSlot }): void {
  fs.rmSync(slotDir(params), { recursive: true, force: true });
}

// Moves a slot: one rename of its directory, so the key, its record and its
// nonce always move together. Never overwrites another slot.
function moveSlot(params: { wallet: string; from: RacSlot; to: RacSlot }): void {
  const from = slotDir({ wallet: params.wallet, slot: params.from });
  const to = slotDir({ wallet: params.wallet, slot: params.to });
  if (!fs.existsSync(from)) return;
  if (fs.existsSync(to)) throw new Error(`Can't move session key ${from}: ${to} already exists`);
  fs.renameSync(from, to);
}

// After a renewal (the old key already retired or parked): the new key
// becomes the live one.
export function promoteNextRac(wallet: string): void {
  if (readRacRecord({ wallet, slot: 'rac' })) {
    throw new Error('The live session key must be retired before promoting the new one');
  }
  clearRacSlot({ wallet, slot: 'rac' });
  moveSlot({ wallet, from: 'rac-next', to: 'rac' });
}

type OwnerRevoker = Pick<OMSWallet['wallet'], 'revokeAccess'>;

// Revokes a parked key: through the key itself, else as the owner (when signed
// in). A key past its lifetime, or one OMS no longer accepts (401), has no
// access left. Forgets the key only once it has none.
async function revokeParked(params: {
  wallet: string;
  slot: RacSlot;
  record: RacRecord;
  owner?: OwnerRevoker;
}): Promise<boolean> {
  const { record } = params;
  let gone = Date.parse(record.expiresAt) <= Date.now();
  if (!gone) {
    try {
      await racClient(params).revokeCredential({ credentialId: record.credentialId });
      gone = true;
    } catch (error) {
      gone = httpStatus(error) === 401;
    }
  }
  if (!gone && params.owner) {
    gone = await params.owner
      .revokeAccess({ credentialId: record.credentialId })
      .then(() => true)
      .catch(() => false);
  }
  if (gone) clearRacSlot(params);
  return gone;
}

// Retires the key in `slot`: parks it, then revokes it. Returns its credential
// id if OMS hasn't confirmed the revoke (it stays parked and is retried by
// retireParkedRacs), else null.
export async function retireRac(params: {
  wallet: string;
  slot: RacSlot;
  owner?: OwnerRevoker;
}): Promise<string | null> {
  const record = readRacRecord(params);
  if (!record) {
    clearRacSlot(params);
    return null;
  }
  const parked: RacSlot = `retiring-${record.credentialId.replace(/[^\w-]/g, '_')}`;
  if (params.slot !== parked) moveSlot({ wallet: params.wallet, from: params.slot, to: parked });
  const gone = await revokeParked({ ...params, slot: parked, record });
  return gone ? null : record.credentialId;
}

export function parkedRacSlots(wallet: string): RacSlot[] {
  const dir = keysDir(wallet);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => PARKED.test(name))
    .map((name): RacSlot => `retiring-${name.slice('retiring-'.length)}`);
}

// Retries every parked key; returns the credential ids still not revoked.
export async function retireParkedRacs(params: {
  wallet: string;
  owner?: OwnerRevoker;
}): Promise<string[]> {
  const pending: string[] = [];
  for (const slot of parkedRacSlots(params.wallet)) {
    const credentialId = await retireRac({ ...params, slot });
    if (credentialId) pending.push(credentialId);
  }
  return pending;
}

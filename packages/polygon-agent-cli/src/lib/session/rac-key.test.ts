// A session key file left broken by a crash or a full disk: replaced while the
// key was never registered, an error once it was. Never a loop, never a
// silent new key for a registered slot.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-rac-'));
const HOME = String(process.env.POLYGON_AGENT_HOME);
const { loadOrCreateRacKey } = await import('./rac.ts');
const { getEncryptionKey } = await import('../storage.ts');

const slot = (wallet: string) => path.join(HOME, 'session', wallet, 'keys', 'rac');

describe('loadOrCreateRacKey', () => {
  it('creates a key once and reads the same key back', () => {
    const key = loadOrCreateRacKey({ wallet: 'w1', slot: 'rac' });
    expect(loadOrCreateRacKey({ wallet: 'w1', slot: 'rac' })).toEqual(key);
    expect(fs.statSync(path.join(slot('w1'), 'key.enc')).mode & 0o777).toBe(0o600);
  });

  it('replaces a broken key file while the key was never registered', () => {
    fs.mkdirSync(slot('w2'), { recursive: true });
    fs.writeFileSync(path.join(slot('w2'), 'key.enc'), '');
    expect(loadOrCreateRacKey({ wallet: 'w2', slot: 'rac' })).toHaveLength(32);
  });

  it('refuses, rather than loops or replaces, a broken key that was registered', () => {
    fs.mkdirSync(slot('w3'), { recursive: true });
    fs.writeFileSync(path.join(slot('w3'), 'key.enc'), '{"iv":');
    fs.writeFileSync(path.join(slot('w3'), 'record.json'), '{}');
    expect(() => loadOrCreateRacKey({ wallet: 'w3', slot: 'rac' })).toThrow(/unreadable/);
    expect(fs.readFileSync(path.join(slot('w3'), 'key.enc'), 'utf8')).toBe('{"iv":');
  });
});

describe('getEncryptionKey', () => {
  it('is 32 bytes, owner-only, created once', () => {
    const key = getEncryptionKey();
    expect(key).toHaveLength(32);
    expect(getEncryptionKey()).toEqual(key);
    expect(fs.statSync(path.join(HOME, '.encryption-key')).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(HOME).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('refuses a damaged key file instead of using it', () => {
    const file = path.join(HOME, '.encryption-key');
    const good = fs.readFileSync(file);
    fs.writeFileSync(file, good.subarray(0, 10));
    expect(() => getEncryptionKey()).toThrow(/damaged/);
    fs.writeFileSync(file, good);
  });
});

import { describe, it, expect } from 'vitest';

import type { SessionPayload } from './src/types.js';

import {
  generateX25519Keypair,
  encryptSession,
  decryptSession,
  generateCode,
  computeCodeHash
} from './src/crypto.js';
import { bytesToHex } from './src/encoding.js';

const SAMPLE_PAYLOAD: SessionPayload = {
  version: 1,
  wallet_address: '0xc448e20a23d9ca5b0f9d667c6676f64c73cff8b7',
  chain_id: 137,
  session_private_key: '0x' + 'ab'.repeat(32),
  session_address: '0x' + 'cd'.repeat(20),
  permissions: { native_limit: '2000000000000000000', erc20_limits: [] },
  expiry: Math.floor(Date.now() / 1000) + 86400 * 183,
  ecosystem_wallet_url: 'https://wallet.sequence.app',
  dapp_origin: 'https://agentconnect.polygon.technology',
  project_access_key: 'AQAAAAAAAAAAAAAAAAAAAAAAAAAtest'
};

describe('session encrypt/decrypt round-trip', () => {
  it('decrypts to original payload', () => {
    const { secretKey: cliSk, publicKey: cliPk } = generateX25519Keypair();
    const requestId = 'abc12345';
    const cliPkHex = bytesToHex(cliPk);

    const { encrypted, code } = encryptSession(SAMPLE_PAYLOAD, cliPkHex, requestId);

    expect(code).toMatch(/^\d{6}$/);
    expect(encrypted.wallet_pk_hex).toHaveLength(64);
    expect(encrypted.nonce_hex).toHaveLength(48);

    const decrypted = decryptSession(encrypted, cliSk, code, requestId);
    expect(decrypted.wallet_address).toBe(SAMPLE_PAYLOAD.wallet_address);
    expect(decrypted.chain_id).toBe(137);
    expect(decrypted.session_private_key).toBe(SAMPLE_PAYLOAD.session_private_key);
  });

  it('throws on wrong code', () => {
    const { secretKey: cliSk, publicKey: cliPk } = generateX25519Keypair();
    const requestId = 'abc12345';
    const { encrypted } = encryptSession(SAMPLE_PAYLOAD, bytesToHex(cliPk), requestId);
    expect(() => decryptSession(encrypted, cliSk, '000000', requestId)).toThrow();
  });

  it('generates 6-digit codes', () => {
    for (let i = 0; i < 20; i++) {
      const code = generateCode();
      expect(code).toMatch(/^\d{6}$/);
      expect(parseInt(code)).toBeGreaterThanOrEqual(0);
      expect(parseInt(code)).toBeLessThan(1_000_000);
    }
  });

  it('computeCodeHash is deterministic', () => {
    const h1 = computeCodeHash('req123', '847291');
    const h2 = computeCodeHash('req123', '847291');
    expect(bytesToHex(h1)).toBe(bytesToHex(h2));
  });
});

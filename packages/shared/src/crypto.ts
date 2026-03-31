import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { randomBytes } from '@noble/hashes/utils';

import type { EncryptedPayload, SessionPayload } from './types.js';

import { PROTOCOL_VERSION, CODE_LENGTH } from './constants.js';
import { bytesToHex, hexToBytes, b64urlEncode, b64urlDecode } from './encoding.js';

export interface X25519Keypair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export function generateX25519Keypair(): X25519Keypair {
  const secretKey = randomBytes(32);
  const publicKey = x25519.getPublicKey(secretKey);
  return { secretKey, publicKey };
}

/** Generates a random 6-digit code string, zero-padded. */
export function generateCode(): string {
  // Use 4 random bytes, take mod 1_000_000 to get 0–999999
  const bytes = randomBytes(4);
  const n = new DataView(bytes.buffer).getUint32(0) % 1_000_000;
  return n.toString().padStart(CODE_LENGTH, '0');
}

/** SHA-256(requestId + code). Used as the code_hash sent to the relay. */
export function computeCodeHash(requestId: string, code: string): Uint8Array {
  if (!requestId) throw new Error('requestId must not be empty');
  return sha256(new TextEncoder().encode(requestId + code));
}

function deriveEncKey(
  shared: Uint8Array,
  code: string,
  cliPkHex: string,
  walletPkHex: string
): Uint8Array {
  const salt = sha256(new TextEncoder().encode(code));
  const info = new TextEncoder().encode(cliPkHex + walletPkHex + PROTOCOL_VERSION);
  return hkdf(sha256, shared, salt, info, 32);
}

/**
 * Encrypt a SessionPayload for the CLI to decrypt.
 * Returns the EncryptedPayload (to POST to relay) and the plaintext code (to display to user).
 */
export function encryptSession(
  payload: SessionPayload,
  cliPkHex: string,
  requestId: string
): { encrypted: EncryptedPayload; code: string } {
  const cliPk = hexToBytes(cliPkHex);
  const { secretKey: walletSk, publicKey: walletPk } = generateX25519Keypair();
  const shared = x25519.getSharedSecret(walletSk, cliPk);

  const walletPkHex = bytesToHex(walletPk);
  const code = generateCode();
  const encKey = deriveEncKey(shared, code, cliPkHex, walletPkHex);

  const nonce = randomBytes(24);
  const aad = new Uint8Array([...cliPk, ...walletPk]);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));

  const cipher = xchacha20poly1305(encKey, nonce, aad);
  const ciphertext = cipher.encrypt(plaintext);

  const encrypted: EncryptedPayload = {
    wallet_pk_hex: walletPkHex,
    nonce_hex: bytesToHex(nonce),
    ciphertext_b64url: b64urlEncode(ciphertext),
    code_hash_hex: bytesToHex(computeCodeHash(requestId, code))
  };

  return { encrypted, code };
}

/**
 * Decrypt a session payload received from the relay.
 * The code is provided by the user out-of-band.
 */
export function decryptSession(
  encrypted: EncryptedPayload,
  cliSk: Uint8Array,
  code: string,
  requestId: string
): SessionPayload {
  if (!requestId) throw new Error('requestId must not be empty');
  const cliPk = x25519.getPublicKey(cliSk);
  const walletPk = hexToBytes(encrypted.wallet_pk_hex);
  const shared = x25519.getSharedSecret(cliSk, walletPk);

  const cliPkHex = bytesToHex(cliPk);
  const walletPkHex = encrypted.wallet_pk_hex;
  const encKey = deriveEncKey(shared, code, cliPkHex, walletPkHex);

  const nonce = hexToBytes(encrypted.nonce_hex);
  const aad = new Uint8Array([...cliPk, ...walletPk]);
  const ciphertext = b64urlDecode(encrypted.ciphertext_b64url);

  // Verify the code hash before attempting decryption
  const expectedHash = bytesToHex(computeCodeHash(requestId, code));
  if (expectedHash !== encrypted.code_hash_hex) {
    throw new Error('Invalid code: hash mismatch');
  }

  const cipher = xchacha20poly1305(encKey, nonce, aad);
  // xchacha20poly1305.decrypt throws if auth tag fails
  const plaintext = cipher.decrypt(ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext)) as SessionPayload;
}

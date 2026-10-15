import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { EthereumPrivateKeyCredentialSigner } from '@polygonlabs/oms-wallet';

import { PersistentNonceSigner } from './rac-signer.ts';

function nonceFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-nonce-')), 'rac.nonce.json');
}

describe('PersistentNonceSigner', () => {
  it('signs exactly like the SDK signer and has the same credential id', async () => {
    const key = randomBytes(32);
    const ours = new PersistentNonceSigner({ privateKey: key, nonceFile: nonceFile() });
    const sdk = new EthereumPrivateKeyCredentialSigner(key);
    expect(await ours.credentialId()).toBe(await sdk.credentialId());
    expect(ours.signingAlgorithm).toBe(sdk.signingAlgorithm);
    const preimage = '/RegisterCredential\n1759700000000\nproject\n{"a":1}';
    expect(await ours.sign(preimage)).toBe(await sdk.sign(preimage));
  });

  it('keeps nonces strictly increasing across instances (processes), even within one millisecond', async () => {
    const file = nonceFile();
    const key = randomBytes(32);
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const nonces: bigint[] = [];
      for (let i = 0; i < 3; i++) {
        const signer = new PersistentNonceSigner({ privateKey: key, nonceFile: file });
        nonces.push(BigInt(await signer.nextNonce()), BigInt(await signer.nextNonce()));
      }
      expect(nonces).toEqual([1000n, 1001n, 1002n, 1003n, 1004n, 1005n]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('never goes backwards when the clock does', async () => {
    const file = nonceFile();
    const signer = new PersistentNonceSigner({ privateKey: randomBytes(32), nonceFile: file });
    fs.writeFileSync(file, JSON.stringify({ lastNonce: String(Date.now() + 60_000) }));
    const next = BigInt(await signer.nextNonce());
    expect(next).toBe(BigInt(JSON.parse(fs.readFileSync(file, 'utf8')).lastNonce));
    expect(next > BigInt(Date.now())).toBe(true);
  });
});

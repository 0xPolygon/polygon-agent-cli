// A CredentialSigner for the session key that persists its request nonce.
//
// The SDK's EthereumPrivateKeyCredentialSigner signs the same way but keeps its
// nonce in memory, starting over in every process. Each CLI command is a new
// process, so ours stores the last nonce and always moves past it:
// max(now, last + 1). Callers hold the wallet lock, so requests on one key are
// sent one at a time and in nonce order.

import { keccak256, toBytes, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';

import type { CredentialSigner } from '@polygonlabs/oms-wallet';

import { readJsonFile, writeJsonFile } from './state.ts';

const NonceFile = z.object({ lastNonce: z.string() });

export class PersistentNonceSigner implements CredentialSigner {
  readonly signingAlgorithm = 'ecdsa-p256k-eip191' as const;
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly nonceFile: string;

  constructor(params: { privateKey: Uint8Array; nonceFile: string }) {
    this.account = privateKeyToAccount(toHex(params.privateKey));
    this.nonceFile = params.nonceFile;
  }

  async credentialId(): Promise<string> {
    return this.account.address;
  }

  async nextNonce(): Promise<string> {
    const stored = NonceFile.safeParse(readJsonFile(this.nonceFile));
    const last = stored.success ? BigInt(stored.data.lastNonce) : 0n;
    const now = BigInt(Date.now());
    const next = now > last ? now : last + 1n;
    writeJsonFile({ file: this.nonceFile, data: { lastNonce: next.toString() } });
    return next.toString();
  }

  // Same as the SDK: an EIP-191 signature over keccak256 of the preimage.
  async sign(preimage: string): Promise<string> {
    return this.account.signMessage({ message: keccak256(toBytes(preimage)) });
  }
}

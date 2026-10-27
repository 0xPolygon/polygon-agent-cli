// The connection key's request signer. OMS wants every request nonce above the
// last one, so the last nonce is stored with the key (in the connection's
// Durable Object, which sends one request at a time) and each new one is
// max(now, last + 1). Signs like the SDK's EthereumPrivateKeyCredentialSigner.

import { keccak256, toBytes, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { CredentialSigner } from '@polygonlabs/oms-wallet';

export interface NonceStore {
  get(): Promise<bigint>;
  put(nonce: bigint): Promise<void>;
}

export class StoredNonceSigner implements CredentialSigner {
  readonly signingAlgorithm = 'ecdsa-p256k-eip191' as const;
  private readonly account: ReturnType<typeof privateKeyToAccount>;

  constructor(
    privateKey: Uint8Array,
    private readonly nonces: NonceStore
  ) {
    this.account = privateKeyToAccount(toHex(privateKey));
  }

  async credentialId(): Promise<string> {
    return this.account.address;
  }

  async nextNonce(): Promise<string> {
    const last = await this.nonces.get();
    const now = BigInt(Date.now());
    const next = now > last ? now : last + 1n;
    await this.nonces.put(next);
    return next.toString();
  }

  async sign(preimage: string): Promise<string> {
    return this.account.signMessage({ message: keccak256(toBytes(preimage)) });
  }
}

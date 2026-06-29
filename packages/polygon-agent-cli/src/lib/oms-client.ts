// OMSClient factory — builds a per-process, per-wallet Sequence V3 client backed
// by file storage + a persisted credential signer, so sessions survive restarts.

import { EthereumPrivateKeyCredentialSigner, OMSClient } from '@0xsequence/typescript-sdk';

import { FileStorageManager, loadOrCreateCredentialKey } from './oms-storage.ts';
import { loadOmsConfig } from './storage.ts';

const cache = new Map<string, OMSClient>();

/**
 * Get (or build) the OMSClient for a wallet name. Cached per-process so repeated
 * calls within one CLI invocation reuse the same client + storage handle.
 *
 * Reads publishableKey + projectId from env or builder.json (loadOmsConfig).
 * Throws a clear error if OMS credentials are not configured.
 */
export function getOmsClient(walletName: string): OMSClient {
  const cached = cache.get(walletName);
  if (cached) return cached;

  const cfg = loadOmsConfig();
  if (!cfg) {
    throw new Error(
      'OMS credentials not configured. Set SEQUENCE_PUBLISHABLE_KEY ' +
        '(or run `polygon-agent setup`). Get it from the Sequence Builder dashboard.'
    );
  }

  const credentialSigner = new EthereumPrivateKeyCredentialSigner(
    loadOrCreateCredentialKey(walletName)
  );

  // SDK 0.1.0-alpha.4: the publishableKey alone identifies the project.
  const oms = new OMSClient({
    publishableKey: cfg.publishableKey,
    storage: new FileStorageManager(walletName),
    credentialSigner
  });

  cache.set(walletName, oms);
  return oms;
}

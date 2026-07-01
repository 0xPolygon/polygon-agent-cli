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
  // `redirectAuthStorage` is REQUIRED for the OIDC browser flow: in Node the SDK
  // has no sessionStorage to fall back to and throws without it. We back it with
  // a separate file store so the transient pending-auth state is isolated from
  // the session store (and the email-login/tx paths simply ignore it).
  const oms = new OMSClient({
    publishableKey: cfg.publishableKey,
    storage: new FileStorageManager(walletName),
    redirectAuthStorage: new FileStorageManager(walletName, 'redirect-store'),
    credentialSigner
  });

  cache.set(walletName, oms);
  return oms;
}

/**
 * The OIDC relay redirect URI. Google only ever sees this (pre-registered) HTTPS
 * callback; the relay bounces the auth code back to our localhost. Overridable
 * via SEQUENCE_OIDC_RELAY_URI so production can point at a non-staging relay
 * without a code change. When unset, the SDK's built-in default is used (pass
 * undefined and the provider default applies).
 */
export function oidcRelayRedirectUri(): string | undefined {
  return process.env.SEQUENCE_OIDC_RELAY_URI || undefined;
}

/**
 * Base URL of OUR OIDC handoff relay (packages/oidc-relay), used by the `--remote`
 * browser-login path when a localhost callback can't be reached. This is a
 * DIFFERENT relay from oidcRelayRedirectUri(): that one overrides the Sequence
 * relay Google redirects to; this is our public bounce target the CLI polls.
 * Read from POLYGON_AGENT_OIDC_RELAY; the `--relay-url` flag overrides per-run.
 * Trailing slash trimmed so callers can append `/api/oidc/...` cleanly.
 */
export function oidcRelayBaseUrl(): string | undefined {
  const v = process.env.POLYGON_AGENT_OIDC_RELAY;
  return v ? v.replace(/\/+$/, '') : undefined;
}

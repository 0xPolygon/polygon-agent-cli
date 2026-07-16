// OMSWallet factory — builds a per-process, per-wallet OMS V3 client backed
// by file storage + a persisted credential signer, so sessions survive restarts.

import { EthereumPrivateKeyCredentialSigner, OMSWallet } from '@polygonlabs/oms-wallet';

import { FileStorageManager, loadOrCreateCredentialKey } from './oms-storage.ts';
import { loadOmsConfig } from './storage.ts';

const cache = new Map<string, OMSWallet>();

/**
 * Get (or build) the OMSWallet for a wallet name. Cached per-process so repeated
 * calls within one CLI invocation reuse the same client + storage handle.
 *
 * Reads publishableKey + projectId from env or builder.json (loadOmsConfig),
 * falling back to the baked-in default publishable key.
 */
export function getOmsClient(walletName: string): OMSWallet {
  const cached = cache.get(walletName);
  if (cached) return cached;

  const cfg = loadOmsConfig();

  const credentialSigner = new EthereumPrivateKeyCredentialSigner(
    loadOrCreateCredentialKey(walletName)
  );

  // The publishableKey alone identifies the project. `redirectAuthStorage` is
  // REQUIRED for the OIDC browser flow: in Node the SDK has no sessionStorage
  // to fall back to and throws without it. We back it with a separate file
  // store so the transient pending-auth state is isolated from the session
  // store (and the email-login/tx paths simply ignore it).
  const oms = new OMSWallet({
    publishableKey: cfg.publishableKey,
    storage: new FileStorageManager(walletName),
    redirectAuthStorage: new FileStorageManager(walletName, 'redirect-store'),
    credentialSigner
  });

  cache.set(walletName, oms);
  return oms;
}

// Baked-in defaults for the browser-login flow so `wallet login` needs no env
// vars. Production domains, provisioned by the oidc-relay and agentconnect-ui
// deploys on merge to main. Override per environment (or to test against
// staging) with POLYGON_AGENT_OIDC_RELAY / POLYGON_AGENT_LOGIN_UI.
const DEFAULT_OIDC_RELAY = 'https://oidc-relay.polygon.technology';
const DEFAULT_LOGIN_UI = 'https://agentconnect.polygon.technology';

/**
 * Base URL of our login pairing relay (packages/oidc-relay). Read from
 * POLYGON_AGENT_OIDC_RELAY with a production default; `--relay-url` overrides
 * per-run. Trailing slash trimmed so callers can append `/api/...` cleanly.
 */
export function oidcRelayBaseUrl(): string {
  const v = process.env.POLYGON_AGENT_OIDC_RELAY;
  return v ? v.replace(/\/+$/, '') : DEFAULT_OIDC_RELAY;
}

/** Base URL of the agentconnect login page. POLYGON_AGENT_LOGIN_UI overrides. */
export function loginUiBaseUrl(): string {
  const v = process.env.POLYGON_AGENT_LOGIN_UI;
  return v ? v.replace(/\/+$/, '') : DEFAULT_LOGIN_UI;
}

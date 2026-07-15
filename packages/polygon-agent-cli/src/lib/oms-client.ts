// OMSClient factory — builds a per-process, per-wallet OMS V3 client backed
// by file storage + a persisted credential signer, so sessions survive restarts.

import { EthereumPrivateKeyCredentialSigner, OMSClient } from '@0xsequence/typescript-sdk';

import { FileStorageManager, loadOrCreateCredentialKey } from './oms-storage.ts';
import { loadOmsConfig } from './storage.ts';

const cache = new Map<string, OMSClient>();

/**
 * Get (or build) the OMSClient for a wallet name. Cached per-process so repeated
 * calls within one CLI invocation reuse the same client + storage handle.
 *
 * Reads publishableKey + projectId from env or builder.json (loadOmsConfig),
 * falling back to the baked-in default publishable key.
 */
export function getOmsClient(walletName: string): OMSClient {
  const cached = cache.get(walletName);
  if (cached) return cached;

  const cfg = loadOmsConfig();

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

// Baked-in defaults for the browser-login flow so `wallet login` needs no env
// vars. STAGING values while this ships from the staging branch; flip to the
// production domains (oidc-relay.polygon.technology / agentconnect.polygon.technology)
// before the npm release, once the relay custom domain is live and Sequence has
// allowlisted its /api/oidc/cb (see docs/superpowers/specs/2026-07-13-browser-login-design.md).
// Override per environment with POLYGON_AGENT_OIDC_RELAY / POLYGON_AGENT_LOGIN_UI.
const DEFAULT_OIDC_RELAY = 'https://oidc-relay-staging.polygon-technology.workers.dev';
const DEFAULT_LOGIN_UI = 'https://agentconnect.staging.polygon.technology';

/**
 * Base URL of OUR OIDC handoff + login relay (packages/oidc-relay). Read from
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

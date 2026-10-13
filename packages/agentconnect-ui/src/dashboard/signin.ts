// Signing in on the onboarding page, straight to OMS from the browser (no CLI
// pairing session). The page only needs the agent wallet's address to open the
// dashboard, so the owner session is signed out as soon as it has it.

import {
  EthereumPrivateKeyCredentialSigner,
  OMSWallet,
  OmsRelayOidcProviders
} from '@polygonlabs/oms-wallet';

import { omsPublishableKey } from '../config';

// Set while a Google sign-in started here is out at the relay. The relay
// returns to the static `/login` (its allowlist is an exact match), and this
// marker tells that page the return belongs to onboarding, not to a CLI.
export const WEB_SIGNIN_KEY = 'agentconnect_web_signin';

// The sign-in's credential key, the same kind the CLI uses (the project
// rejects WebCrypto P-256 credentials). It lives in sessionStorage only so a
// Google sign-in can finish after the redirect, and is dropped on sign-out.
const KEY_STORE = 'agentconnect_web_signin_key';
function credentialKey(): Uint8Array {
  const hex = (() => {
    try {
      return sessionStorage.getItem(KEY_STORE);
    } catch {
      return null;
    }
  })();
  if (hex) return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
  const key = crypto.getRandomValues(new Uint8Array(32));
  try {
    sessionStorage.setItem(
      KEY_STORE,
      Array.from(key, (b) => b.toString(16).padStart(2, '0')).join('')
    );
  } catch {
    // Email sign-in still works within this page load.
  }
  return key;
}

let client: OMSWallet | null = null;
function oms(): OMSWallet {
  client ??= new OMSWallet({
    publishableKey: omsPublishableKey,
    credentialSigner: new EthereumPrivateKeyCredentialSigner(credentialKey())
  });
  return client;
}

// The same wallet the CLI picks (`selectMainWallet`): the account's own, not an
// imported one. Then sign out; the dashboard reads public data only.
async function mainWalletAndSignOut(): Promise<string> {
  const w = oms().wallet;
  try {
    const wallets = await w.listWallets();
    const main = wallets.find((x) => x.keyOrigin !== 'imported');
    if (!main) throw new Error('No agent wallet on this account');
    return main.address;
  } finally {
    await w.signOut().catch(() => {});
    sessionStorage.removeItem(KEY_STORE);
    client = null;
  }
}

export async function startEmail(email: string): Promise<void> {
  await oms().wallet.startEmailAuth({ email });
}

export async function finishEmail(code: string): Promise<string> {
  await oms().wallet.completeEmailAuth({ code, walletSelection: 'automatic' });
  return mainWalletAndSignOut();
}

/** Sends the browser to Google; it comes back to `/login`. */
export async function startGoogle(): Promise<void> {
  const { authorizationUrl } = await oms().wallet.startOidcRedirectAuth({
    provider: OmsRelayOidcProviders.google,
    omsRelayReturnUri: `${window.location.origin}/login`
  });
  sessionStorage.setItem(WEB_SIGNIN_KEY, '1');
  window.location.assign(authorizationUrl);
}

/** True when this `/login` load is a Google return for an onboarding sign-in. */
export function isWebSigninReturn(): boolean {
  try {
    return sessionStorage.getItem(WEB_SIGNIN_KEY) === '1';
  } catch {
    return false;
  }
}

export async function finishGoogle(): Promise<string> {
  sessionStorage.removeItem(WEB_SIGNIN_KEY);
  await oms().wallet.completeOidcRedirectAuth({
    callbackUrl: window.location.href,
    walletSelection: 'automatic'
  });
  return mainWalletAndSignOut();
}

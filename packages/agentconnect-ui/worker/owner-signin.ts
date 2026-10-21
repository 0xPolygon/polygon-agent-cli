// Owner sign-in for connecting an MCP client: the worker signs in to OMS the
// way the CLI does (email code or Google), finds the agent wallet, and signs
// out. Each step is its own request, so the SDK's state between them (the
// credential key, its storage, an email attempt) is kept sealed in KV for ten
// minutes. Signing in from the worker, not the browser, works on any domain:
// the OMS project only accepts browser calls from the production origin.

import type { AuthRequest } from '@cloudflare/workers-oauth-provider';

import type { StorageManager } from '@polygonlabs/oms-wallet';

import {
  EthereumPrivateKeyCredentialSigner,
  OMSWallet,
  OmsRelayOidcProviders
} from '@polygonlabs/oms-wallet';

import type { SealedKv } from './store.ts';

import { ValidationError } from './shipping.ts';

const TTL_SECONDS = 600;
// The SDK keeps an email sign-in attempt on this field between the two steps
// (the CLI saves it the same way; see lib/owner/email-attempt.ts).
const EMAIL_ATTEMPT_FIELD = 'activeEmailAuthAttempt';

interface EmailAttempt {
  email: string;
  verifier: string;
  challenge: string;
  sessionLifetimeSeconds: number;
}

export interface PendingConnect {
  // Connecting an MCP client: its authorization request and name.
  authRequest?: AuthRequest;
  clientName?: string;
  // Who signed in.
  signedIn?: SignedIn;
  // The OMS credential key for this sign-in only (hex).
  key: string;
  storage: Record<string, string>;
  redirect: Record<string, string>;
  emailAttempt?: EmailAttempt;
}

export interface SignedIn {
  wallet: string;
  email: string | null;
}

class SnapshotStorage implements StorageManager {
  constructor(readonly data: Record<string, string>) {}
  get(key: string) {
    return this.data[key] ?? null;
  }
  set(key: string, value: string) {
    this.data[key] = value;
  }
  delete(key: string) {
    delete this.data[key];
  }
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
const keyName = (id: string) => `mcpconnect:${id}`;

function emailFromIdToken(token: string): string | null {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(payload)) as { email?: string };
    return claims.email ?? null;
  } catch {
    return null;
  }
}

export class OwnerSignIn {
  constructor(
    private readonly sealed: SealedKv,
    private readonly publishableKey: string
  ) {}

  /**
   * Start a sign-in, for connecting an MCP client or signing in on the site.
   * Returns the id the page carries between steps.
   */
  async create(purpose: Pick<PendingConnect, 'authRequest' | 'clientName'>): Promise<string> {
    const id = hex(crypto.getRandomValues(new Uint8Array(16)));
    const pending: PendingConnect = {
      ...purpose,
      key: hex(crypto.getRandomValues(new Uint8Array(32))),
      storage: {},
      redirect: {}
    };
    await this.sealed.put(keyName(id), pending, { expirationTtl: TTL_SECONDS });
    return id;
  }

  async load(id: string): Promise<PendingConnect> {
    const pending = /^[0-9a-f]{32}$/.test(id)
      ? await this.sealed.get<PendingConnect>(keyName(id))
      : null;
    if (!pending) throw new ValidationError('This sign-in expired. Start again.');
    return pending;
  }

  private async save(id: string, pending: PendingConnect): Promise<void> {
    await this.sealed.put(keyName(id), pending, { expirationTtl: TTL_SECONDS });
  }

  /** Keep who signed in, for a decision made in a later request. */
  async markSignedIn(id: string, who: SignedIn): Promise<void> {
    const pending = await this.load(id);
    await this.save(id, { ...pending, signedIn: who });
  }

  async forget(id: string): Promise<void> {
    // Overwrite with a short-lived tombstone; KV has no delete in every binding we fake.
    await this.sealed.put(keyName(id), null, { expirationTtl: 60 });
  }

  private wallet(pending: PendingConnect) {
    const storage = new SnapshotStorage(pending.storage);
    const redirect = new SnapshotStorage(pending.redirect);
    const oms = new OMSWallet({
      publishableKey: this.publishableKey,
      storage,
      redirectAuthStorage: redirect,
      credentialSigner: new EthereumPrivateKeyCredentialSigner(unhex(pending.key))
    });
    return oms.wallet;
  }

  async startEmail(id: string, email: string): Promise<void> {
    const pending = await this.load(id);
    const w = this.wallet(pending);
    await w.startEmailAuth({ email });
    pending.emailAttempt = Reflect.get(w, EMAIL_ATTEMPT_FIELD) as EmailAttempt;
    if (!pending.emailAttempt?.verifier) {
      throw new Error('The wallet SDK changed how it keeps an email sign-in attempt');
    }
    const { email: e, verifier, challenge, sessionLifetimeSeconds } = pending.emailAttempt;
    pending.emailAttempt = { email: e, verifier, challenge, sessionLifetimeSeconds };
    await this.save(id, pending);
  }

  async finishEmail(id: string, code: string): Promise<SignedIn> {
    const pending = await this.load(id);
    if (!pending.emailAttempt) throw new ValidationError('Send the code to your email first.');
    const w = this.wallet(pending);
    Reflect.set(w, EMAIL_ATTEMPT_FIELD, { ...pending.emailAttempt });
    await w.completeEmailAuth({ code, walletSelection: 'automatic' });
    return this.walletAndSignOut(w, pending.emailAttempt.email);
  }

  /** The Google page to send the browser to; it comes back to `returnUri`. */
  async startGoogle(id: string, returnUri: string): Promise<string> {
    const pending = await this.load(id);
    const w = this.wallet(pending);
    const { authorizationUrl } = await w.startOidcRedirectAuth({
      provider: OmsRelayOidcProviders.google,
      omsRelayReturnUri: returnUri
    });
    await this.save(id, pending);
    return authorizationUrl;
  }

  async finishGoogle(id: string, callbackUrl: string): Promise<SignedIn> {
    const pending = await this.load(id);
    const w = this.wallet(pending);
    await w.completeOidcRedirectAuth({
      callbackUrl,
      cleanUrl: false,
      walletSelection: 'automatic'
    });
    return this.walletAndSignOut(w, null);
  }

  // The same wallet the CLI picks: the account's own, not an imported one.
  private async walletAndSignOut(
    w: ReturnType<OwnerSignIn['wallet']>,
    email: string | null
  ): Promise<SignedIn> {
    try {
      const main = (await w.listWallets()).find((x) => x.keyOrigin !== 'imported');
      if (!main) throw new ValidationError('No agent wallet on this account.');
      const idToken = email ? null : await w.getIdToken().catch(() => null);
      return {
        wallet: main.address.toLowerCase(),
        email: email ?? (idToken && emailFromIdToken(idToken))
      };
    } finally {
      await w.signOut().catch(() => {});
    }
  }
}

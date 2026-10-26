// Owner sign-in for connecting an MCP client: the worker signs in to OMS the
// way the CLI does (email code or Google), finds the agent wallet, and signs
// out. A connection that will move money keeps the owner signed in until they
// allow or deny it, so the allowance can be approved as the owner (withOwner),
// and signs out then. Each step is its own request, so the SDK's state between them (the
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

/** A request the owner can fix (a missing field, an expired sign-in). */
export class ValidationError extends Error {}

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
  // The owner is still signed in (in `storage`), until the decision.
  ownerSession?: boolean;
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

  private oms(pending: PendingConnect) {
    return new OMSWallet({
      publishableKey: this.publishableKey,
      storage: new SnapshotStorage(pending.storage),
      redirectAuthStorage: new SnapshotStorage(pending.redirect),
      credentialSigner: new EthereumPrivateKeyCredentialSigner(unhex(pending.key))
    });
  }

  private wallet(pending: PendingConnect) {
    return this.oms(pending).wallet;
  }

  /**
   * Runs `fn` as the owner, still signed in from this page, then signs out and
   * forgets the sign-in, whatever `fn` does.
   */
  async withOwner<T>(id: string, fn: (oms: OMSWallet) => Promise<T>): Promise<T> {
    const pending = await this.load(id);
    if (!pending.ownerSession) throw new ValidationError('Sign in again to approve spending.');
    const oms = this.oms(pending);
    try {
      return await fn(oms);
    } finally {
      await oms.wallet.signOut().catch(() => {});
      await this.forget(id);
    }
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

  /** `keep`: stay signed in until the decision (a connection that moves money). */
  async finishEmail(id: string, code: string, keep = false): Promise<SignedIn> {
    const pending = await this.load(id);
    if (!pending.emailAttempt) throw new ValidationError('Send the code to your email first.');
    const w = this.wallet(pending);
    Reflect.set(w, EMAIL_ATTEMPT_FIELD, { ...pending.emailAttempt });
    await w.completeEmailAuth({ code, walletSelection: 'automatic' });
    const email = pending.emailAttempt.email;
    return keep
      ? this.walletKeepingSession(id, pending, w, email)
      : this.walletAndSignOut(w, email);
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

  async finishGoogle(id: string, callbackUrl: string, keep = false): Promise<SignedIn> {
    const pending = await this.load(id);
    const w = this.wallet(pending);
    await w.completeOidcRedirectAuth({
      callbackUrl,
      cleanUrl: false,
      walletSelection: 'automatic'
    });
    return keep ? this.walletKeepingSession(id, pending, w, null) : this.walletAndSignOut(w, null);
  }

  // As walletAndSignOut, but the owner stays signed in: the session (in the
  // snapshot storage the SDK just wrote) is kept sealed for the decision.
  private async walletKeepingSession(
    id: string,
    pending: PendingConnect,
    w: ReturnType<OwnerSignIn['wallet']>,
    email: string | null
  ): Promise<SignedIn> {
    try {
      const who = await this.mainWallet(w, email);
      await this.save(id, {
        ...pending,
        emailAttempt: undefined,
        signedIn: who,
        ownerSession: true
      });
      return who;
    } catch (err) {
      await w.signOut().catch(() => {});
      throw err;
    }
  }

  // The same wallet the CLI picks: the account's own, not an imported one.
  private async walletAndSignOut(
    w: ReturnType<OwnerSignIn['wallet']>,
    email: string | null
  ): Promise<SignedIn> {
    try {
      return await this.mainWallet(w, email);
    } finally {
      await w.signOut().catch(() => {});
    }
  }

  private async mainWallet(
    w: ReturnType<OwnerSignIn['wallet']>,
    email: string | null
  ): Promise<SignedIn> {
    const main = (await w.listWallets()).find((x) => x.keyOrigin !== 'imported');
    if (!main) throw new ValidationError('No agent wallet on this account.');
    const idToken = email ? null : await w.getIdToken().catch(() => null);
    return {
      wallet: main.address.toLowerCase(),
      email: email ?? (idToken && emailFromIdToken(idToken))
    };
  }
}

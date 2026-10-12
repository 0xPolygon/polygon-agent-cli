// Owner requests, in two steps (separate CLI processes):
//
//   1. startOwnerRequest: send the code (email) or register the login page's
//      pairing session (browser), and save the pending request.
//   2. confirmOwnerRequest: sign in with the code or through the login page,
//      run the action, and always revoke the sign-in, so nothing owner-level
//      outlives the command.

import { randomBytes, randomInt } from 'node:crypto';

import type {
  CompleteEmailAuthResult,
  CompleteOidcRedirectAuthResult,
  OmsRelayOidcProvider
} from '@polygonlabs/oms-wallet';

import {
  EthereumPrivateKeyCredentialSigner,
  MemoryStorageManager,
  OMSWallet,
  OmsRelayOidcProviders,
  isOMSWalletError
} from '@polygonlabs/oms-wallet';

import type { BrowserLoginDeps, LoginAction, LoginStatus } from '../browser-login.ts';
import type { OmsWalletPointer } from '../storage.ts';
import type { LoginContext, OwnerAction, PendingRequest } from './pending.ts';

import { runBrowserLogin } from '../browser-login.ts';
import { CliError, mapOmsError, upstreamErrorName } from '../errors.ts';
import { LoginSessionExpiredError, makeLoginRelay } from '../login-relay-client.ts';
import { loginUiBaseUrl, oidcRelayBaseUrl } from '../oms-client.ts';
import { selectMainWallet } from '../polymarket/oms-key.ts';
import { loadOmsConfig, loadOmsWalletPointer } from '../storage.ts';
import { exportEmailAttempt, restoreEmailAttempt } from './email-attempt.ts';
import { deletePending, discardPendingNow, loadPending, savePending } from './pending.ts';

// The owner sign-in's lifetime: as short as OMS allows, so a sign-in whose
// revoke failed dies on its own soon after.
export const OWNER_LOGIN_SECONDS = 600;
export const REQUEST_LIFETIME_MS = 10 * 60 * 1000;
// Consecutive failed relay polls (2s apart, so about a minute) before a
// browser sign-in gives up.
const MAX_POLL_FAILURES = 30;

// A completed owner sign-in, by either method.
type OwnerAuth = CompleteEmailAuthResult | CompleteOidcRedirectAuthResult;

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

// randomInt draws without modulo bias.
function requestId(): string {
  return Array.from({ length: 10 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join('');
}

// A short-lived owner client with an in-memory session and a throwaway key.
export function ownerWallet(ownerKey: Uint8Array): OMSWallet {
  return new OMSWallet({
    publishableKey: loadOmsConfig().publishableKey,
    storage: new MemoryStorageManager(),
    // Google sign-in through the page needs somewhere to keep the redirect
    // state. Start and completion both happen in the one waiter process.
    redirectAuthStorage: new MemoryStorageManager(),
    credentialSigner: new EthereumPrivateKeyCredentialSigner(ownerKey)
  });
}

// The login page for a browser request's pairing session.
export function loginPageUrl(relaySession: string): string {
  return `${loginUiBaseUrl()}/login#${relaySession}`;
}

export async function startOwnerRequest(
  params: { wallet: string; action: OwnerAction; now: Date } & (
    | { method: 'email'; email: string }
    | { method: 'browser'; context: LoginContext }
  )
): Promise<PendingRequest> {
  const ownerKey = randomBytes(32);
  const base = {
    id: requestId(),
    wallet: params.wallet,
    action: params.action,
    ownerKey: ownerKey.toString('hex'),
    createdAt: params.now.toISOString(),
    expiresAt: new Date(params.now.getTime() + REQUEST_LIFETIME_MS).toISOString()
  };
  let request: PendingRequest;
  if (params.method === 'email') {
    const owner = ownerWallet(ownerKey);
    try {
      await owner.wallet.startEmailAuth({
        email: params.email,
        sessionLifetimeSeconds: OWNER_LOGIN_SECONDS
      });
    } catch (error) {
      throw mapOmsError(error);
    }
    request = {
      ...base,
      method: 'email',
      email: params.email,
      attempt: exportEmailAttempt(owner.wallet)
    };
  } else {
    // The sign-in itself happens in step 2, which drives this session.
    const relaySession = randomBytes(16).toString('base64url');
    try {
      await makeLoginRelay(oidcRelayBaseUrl()).registerSession(relaySession, params.context);
    } catch (error) {
      throw new CliError({
        code: 'upstream_unavailable',
        message: `Could not open the sign-in page (${error instanceof Error ? error.message : String(error)}).`,
        hint: 'Check the connection (and POLYGON_AGENT_OIDC_RELAY if set), then try again.',
        cause: error
      });
    }
    request = { ...base, method: 'browser', relaySession };
  }
  await savePending(request);
  return request;
}

function requestExpired(
  message: string,
  hint = 'Start the request again; a new code will be sent.'
): CliError {
  return new CliError({ code: 'request_expired', message, hint });
}

// Signs in with the code. A wrong code (or a rate limit) keeps the request for
// another try. Any other failure deletes it: OMS may have accepted the code
// even if the answer never arrived, and the sign-in key must not stay on disk.
async function signInWithCode(params: {
  request: Extract<PendingRequest, { method: 'email' }>;
  owner: OMSWallet;
  code: string;
}): Promise<OwnerAuth> {
  restoreEmailAttempt({ wallet: params.owner.wallet, attempt: params.request.attempt });
  try {
    return await params.owner.wallet.completeEmailAuth({
      code: params.code.trim(),
      walletSelection: 'automatic'
    });
  } catch (error) {
    const name = upstreamErrorName(error);
    if (name === 'AnswerIncorrect') {
      throw new CliError({
        code: 'invalid_code',
        message: "That code isn't right. Check the latest email and try again.",
        cause: error
      });
    }
    const mapped = mapOmsError(error);
    if (mapped instanceof CliError && mapped.code === 'rate_limited') throw mapped;
    await deletePending({ wallet: params.request.wallet, id: params.request.id });
    if (
      name === 'ChallengeExpired' ||
      name === 'TooManyAttempts' ||
      name === 'CommitmentConsumed' ||
      (isOMSWalletError(error) && error.code === 'OMS_AUTH_COMMITMENT_CONSUMED')
    ) {
      throw requestExpired('The code has expired or was tried too many times.');
    }
    // If OMS did accept the code, that sign-in expires within OWNER_LOGIN_SECONDS.
    throw mapped;
  }
}

// Makes the account's main wallet the active one (automatic selection may land
// on an imported wallet, the Polymarket key). With a pointer, it must be this
// install's wallet: another account is the wrong-account error.
async function selectOwnerMain(params: {
  owner: OMSWallet;
  auth: OwnerAuth;
  pointer: OmsWalletPointer | null;
  method: PendingRequest['method'];
}): Promise<{ address: string }> {
  const { owner, pointer } = params;
  try {
    return await selectMainWallet(owner.wallet, { expectedAddress: pointer?.walletAddress });
  } catch (error) {
    if (pointer && error instanceof CliError && error.code === 'not_connected') {
      const signedIn =
        (await owner.wallet.listWallets().catch(() => []))?.find((w) => w.keyOrigin !== 'imported')
          ?.address ?? params.auth.walletAddress;
      throw new CliError({
        code: 'invalid_input',
        message:
          params.method === 'email'
            ? `That code signed in to ${signedIn}, not this install's wallet ${pointer.walletAddress}. Use the email the wallet was created with.`
            : `That sign-in went to ${signedIn}, not this install's wallet ${pointer.walletAddress}. Sign in with the account the wallet was created with.`,
        cause: error
      });
    }
    throw error;
  }
}

// The browser sign-in's inputs. `deps` replaces the relay, the clock and the
// poll sleep (tests, or a caller with its own relay); the wallet side is always
// the request's owner client, so the sign-in can be revoked.
export interface BrowserSignIn {
  deps?: Partial<Pick<BrowserLoginDeps, 'relay' | 'sleep' | 'now'>>;
  timeoutMs: number;
}

export type OwnerSignInInput = { code: string } | { browser: BrowserSignIn };

// A completed sign-in. `failure` is an error that came after it (the caller
// raises it once the revoke is sure to run). `report` tells the login page how
// it ended; best effort, it never throws.
interface OwnerSignIn {
  auth: OwnerAuth;
  failure?: { error: unknown };
  report?: (status: LoginStatus) => Promise<void>;
}

function cancelled(): CliError {
  return new CliError({
    code: 'request_cancelled',
    message: 'The sign-in was cancelled on the login page.',
    hint: 'Start a new request only if the user asks for it again.'
  });
}

// Signs in on the login page, driving its pairing session from here. Once
// signed in it returns at once, with no further network calls: the main-wallet
// check and the page's final status come after, under the revoking signal
// handler. Fails before the sign-in: the request is over and its file goes.
async function signInWithBrowser(params: {
  request: Extract<PendingRequest, { method: 'browser' }>;
  owner: OMSWallet;
  browser: BrowserSignIn;
}): Promise<OwnerSignIn> {
  const { request, owner } = params;
  const lifetime = { sessionLifetimeSeconds: OWNER_LOGIN_SECONDS };
  const relayBase = oidcRelayBaseUrl();
  const relay = params.browser.deps?.relay ?? makeLoginRelay(relayBase);
  const now = params.browser.deps?.now ?? (() => Date.now());
  let auth: OwnerAuth | undefined;
  let wasCancelled = false;
  let pollFailures = 0;

  const deps: BrowserLoginDeps = {
    relay: {
      registerSession: (session, context) => relay.registerSession(session, context),
      // A failed poll (a relay or network hiccup) is retried until the
      // deadline, unless the relay keeps failing (about a minute) or says the
      // session is over.
      nextAction: async (session) => {
        let action: LoginAction | null;
        try {
          action = await relay.nextAction(session);
        } catch (error) {
          if (error instanceof LoginSessionExpiredError) throw error;
          pollFailures += 1;
          if (pollFailures < MAX_POLL_FAILURES) return null;
          throw new CliError({
            code: 'upstream_unavailable',
            message: `The login page relay stopped answering (${error instanceof Error ? error.message : String(error)}).`,
            hint: 'Start the request again shortly.',
            cause: error
          });
        }
        pollFailures = 0;
        if (action?.type === 'cancel') wasCancelled = true;
        return action;
      },
      // Once signed in, the page hears the outcome from `report` instead.
      setStatus: async (session, status) => {
        if (!auth) await relay.setStatus(session, status);
      }
    },
    wallet: {
      startOidcRedirectAuth: (p) =>
        owner.wallet.startOidcRedirectAuth({
          provider: p.provider as OmsRelayOidcProvider,
          omsRelayReturnUri: p.omsRelayReturnUri,
          ...lifetime
        }),
      completeOidcRedirectAuth: async (p) => {
        const result = await owner.wallet.completeOidcRedirectAuth({ ...p, ...lifetime });
        if (!result) throw new Error('The sign-in did not complete: no wallet was returned.');
        auth = result;
        return { walletAddress: result.walletAddress };
      },
      // completeEmailAuth takes the lifetime from the attempt this starts.
      startEmailAuth: (p) => owner.wallet.startEmailAuth({ ...p, ...lifetime }),
      completeEmailAuth: async (p) => {
        auth = await owner.wallet.completeEmailAuth(p);
        return { walletAddress: auth.walletAddress };
      }
    },
    // No network here: the real selection runs after the pending file is gone.
    selectMainWallet: async () => {
      if (!auth) throw new Error('Not signed in.');
      return { address: auth.walletAddress };
    },
    oidcProviderGoogle: OmsRelayOidcProviders.google,
    announce: async () => undefined,
    sleep: params.browser.deps?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now,
    randomSessionId: () => request.relaySession
  };
  const report = async (status: LoginStatus) => {
    await relay.setStatus(request.relaySession, status).catch(() => undefined);
  };

  // The request's own expiry caps the wait.
  const timeoutMs = Math.min(Date.parse(request.expiresAt) - now(), params.browser.timeoutMs);
  const deadline = now() + timeoutMs;
  try {
    await runBrowserLogin(deps, {
      relayBase,
      uiBase: loginUiBaseUrl(),
      timeoutMs,
      session: request.relaySession,
      timeoutMessage: 'Nobody signed in on the login page in time.'
    });
  } catch (error) {
    if (auth) return { auth, failure: { error }, report };
    await deletePending({ wallet: request.wallet, id: request.id });
    if (wasCancelled) throw cancelled();
    if (now() >= deadline) {
      throw requestExpired(
        'Nobody signed in on the login page in time.',
        'Start the request again for a new login page.'
      );
    }
    throw mapOmsError(error);
  }
  if (!auth) throw new Error('The sign-in did not complete.');
  return { auth, report };
}

export interface OwnerContext {
  owner: OMSWallet;
  walletAddress: string;
  request: PendingRequest;
}

// Signs the owner in by the request's method, after checking the input fits it.
async function signInOwner(params: {
  request: PendingRequest;
  owner: OMSWallet;
  input: OwnerSignInInput;
}): Promise<OwnerSignIn> {
  const { request, owner, input } = params;
  if (request.method === 'email') {
    if (!('code' in input)) {
      throw new CliError({
        code: 'invalid_input',
        message: `Request ${request.id} signs in with the code emailed to ${request.email}.`,
        hint: 'Confirm it with the code from that email.'
      });
    }
    return { auth: await signInWithCode({ request, owner, code: input.code }) };
  }
  if (!('browser' in input)) {
    throw new CliError({
      code: 'invalid_input',
      message: `Request ${request.id} signs in on the login page, not with a code.`,
      hint: `Open ${loginPageUrl(request.relaySession)} to sign in.`
    });
  }
  return signInWithBrowser({ request, owner, browser: input.browser });
}

export async function confirmOwnerRequest<T extends Record<string, unknown>>(
  params: {
    wallet: string;
    requestId: string;
    now: Date;
    run: (context: OwnerContext) => Promise<T>;
    // Browser sign-in only. When given, the login page hears `done` after the
    // action (and the revoke) instead of before it, with whatever this
    // returns merged in (a funding link). A failed action is reported as an
    // error. It runs after the sign-in is revoked, so it may use the network.
    doneExtras?: (result: T) => Promise<{ funding?: { url: string } } | undefined>;
  } & OwnerSignInInput
): Promise<T & { ownerSignInRevoked: boolean; ownerSignInRevokeError?: string }> {
  const request = loadPending(params.wallet);
  if (!request || request.id !== params.requestId) {
    throw requestExpired(`No pending request ${params.requestId} for wallet '${params.wallet}'.`);
  }
  if (Date.parse(request.expiresAt) <= params.now.getTime()) {
    await deletePending({ wallet: params.wallet, id: request.id });
    throw requestExpired(
      'The request has expired (requests last 10 minutes).',
      request.method === 'browser' ? 'Start the request again.' : undefined
    );
  }
  const input: OwnerSignInInput =
    'code' in params ? { code: params.code } : { browser: params.browser };

  const owner = ownerWallet(Buffer.from(request.ownerKey, 'hex'));
  // Interrupted during the sign-in itself (Ctrl-C, kill): the key may already
  // be an owner credential, so it leaves the disk before exiting. Repeated
  // signals are ignored, so a second Ctrl-C can't cut this short.
  let interrupted = false;
  const onSignalSigningIn = (signal: NodeJS.Signals) => {
    if (interrupted) return;
    interrupted = true;
    discardPendingNow(params.wallet);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', onSignalSigningIn);
  process.on('SIGTERM', onSignalSigningIn);
  let signedIn: OwnerSignIn;
  try {
    signedIn = await signInOwner({ request, owner, input });
  } finally {
    process.removeListener('SIGINT', onSignalSigningIn);
    process.removeListener('SIGTERM', onSignalSigningIn);
  }

  const revokeSignIn = async (): Promise<string | undefined> => {
    try {
      await owner.wallet.revokeAccess({ credentialId: signedIn.auth.credential.credentialId });
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      await owner.wallet.signOut().catch(() => undefined);
    }
  };
  // Interrupted mid-action (Ctrl-C, kill): still revoke before exiting, and
  // a second signal doesn't cut the revoke short.
  let revoking = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (revoking) return;
    revoking = true;
    void revokeSignIn().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let outcome: { ok: true; result: T } | { ok: false; error: unknown };
  let walletAddress: string | undefined;
  try {
    // Signed in: the key is now an owner credential, so it leaves the disk at
    // once. A newer request saved meanwhile (a new step 1) is left alone,
    // unless the careful delete fails; then the file goes regardless.
    await deletePending({ wallet: params.wallet, id: request.id }).catch(() =>
      discardPendingNow(params.wallet)
    );
    // Automatic selection may land on an imported wallet (the Polymarket key). Always act
    // on the user's main wallet.
    const pointer = await loadOmsWalletPointer(params.wallet);
    let main: { address: string };
    try {
      if (signedIn.failure) throw signedIn.failure.error;
      main = await selectOwnerMain({ owner, auth: signedIn.auth, pointer, method: request.method });
    } catch (error) {
      await signedIn.report?.({
        status: 'error',
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
    if (!params.doneExtras) {
      await signedIn.report?.({ status: 'done', walletAddress: main.address });
    }
    walletAddress = main.address;
    outcome = {
      ok: true,
      result: await params.run({ owner, walletAddress: main.address, request })
    };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  // Always: revoke the sign-in and drop the client.
  const revokeError = await revokeSignIn();

  // The deferred `done` (see doneExtras); best effort, never fails the action.
  if (params.doneExtras && walletAddress !== undefined && signedIn.report) {
    try {
      if (outcome.ok) {
        const extras = await params.doneExtras(outcome.result).catch(() => undefined);
        await signedIn.report({
          status: 'done',
          walletAddress,
          ...(extras?.funding ? { funding: extras.funding } : {})
        });
      } else {
        await signedIn.report({
          status: 'error',
          message: outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
        });
      }
    } catch {
      // The page is a courtesy; the CLI result stands on its own.
    }
  }

  const revoke = {
    ownerSignInRevoked: revokeError === undefined,
    ...(revokeError === undefined ? {} : { ownerSignInRevokeError: revokeError })
  };
  if (!outcome.ok) {
    const mapped = mapOmsError(outcome.error);
    const error =
      mapped instanceof CliError
        ? mapped
        : new CliError({
            code: 'upstream_error',
            message: mapped instanceof Error ? mapped.message : String(mapped),
            cause: mapped
          });
    error.details = { ...error.details, ...revoke };
    throw error;
  }
  return { ...outcome.result, ...revoke };
}

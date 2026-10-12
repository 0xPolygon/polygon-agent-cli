// Session-mode wallet commands: connecting this install, the allowance,
// withdrawals and access, and status. Owner actions run in two steps
// (lib/owner/requests.ts): the owner signs in with an emailed code, or on the
// login page while a background waiter (lib/owner/waiter.ts) finishes the
// request. Everything else needs no sign-in.

import type { CommandModule } from 'yargs';

import { getAddress, isAddress } from 'viem';

import type { LoginContext, OwnerAction } from '../lib/owner/pending.ts';
import type { OwnerContext } from '../lib/owner/requests.ts';
import type { Plan, PlanToken } from '../lib/session/plan.ts';

import { provisionBuilderOnce } from '../lib/builder-provision.ts';
import { enrollAgent, LINK_TOKEN_TTL_SECONDS, mintAccessToken } from '../lib/credentials/agent.ts';
import {
  CliError,
  bigintReplacer,
  errorJson,
  httpStatus,
  jsonFail,
  jsonOut
} from '../lib/errors.ts';
import { dashboardInfo, fundingUrl } from '../lib/funding.ts';
import { isWalletFunded } from '../lib/indexer.ts';
import { getOmsClient } from '../lib/oms-client.ts';
import { runOwnerAction } from '../lib/owner/actions.ts';
import { deletePending, loadPending } from '../lib/owner/pending.ts';
import {
  REQUEST_LIFETIME_MS,
  confirmOwnerRequest,
  loginPageUrl,
  startOwnerRequest
} from '../lib/owner/requests.ts';
import {
  clearWaiterFiles,
  deleteResult,
  latestWaiterRequest,
  liveWaiters,
  removePid,
  spawnWaiter,
  stopWaiter,
  waitForResult,
  waiterEmailCommand,
  writeEmailFallback,
  writePid,
  writeResult
} from '../lib/owner/waiter.ts';
import { loadAccount } from '../lib/polymarket/account.ts';
import { getUsdPrices } from '../lib/prices.ts';
import { walletHoldings } from '../lib/session/live.ts';
import {
  DEFAULT_ALLOWANCE_USD,
  DEFAULT_DAYS,
  buildPlan,
  planSummary,
  validateAllowance
} from '../lib/session/plan.ts';
import {
  parkedRacSlots,
  racClient,
  hasRacKey,
  readRacRecord,
  registerRac,
  retireParkedRacs,
  retireRac
} from '../lib/session/rac.ts';
import { withWalletKeys } from '../lib/session/renewal.ts';
import {
  parseTokenAtChain,
  requireSupportedChain,
  resolvePlanToken
} from '../lib/session/resolve.ts';
import { getSessions } from '../lib/session/sessions.ts';
import { installName, readApprovedPlan, removeSessionState } from '../lib/session/state.ts';
import {
  allowanceTotals,
  classifyHoldings,
  holdsAnythingOn,
  describeSessions,
  sessionAlerts
} from '../lib/session/status.ts';
import {
  chainLabel,
  defaultPlanChains,
  supportedChainIds,
  supportedTokens
} from '../lib/session/tokens.ts';
import { currentSignInMethod } from '../lib/signin-method.ts';
import { deleteOmsWallet, loadOmsWalletPointer, saveOmsWalletPointer } from '../lib/storage.ts';
import { formatUnits, parseUnits } from '../lib/utils.ts';
import { cliVersion, getLatestVersion, isNewerVersion } from '../lib/version.ts';
import { watchStatus } from '../lib/watch/status.ts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function nameFlag(wallet: string): string {
  return wallet === 'main' ? '' : ` --name ${wallet}`;
}

function confirmCommand(params: { wallet: string; request: string }): string {
  return `polygon-agent wallet confirm --request ${params.request} --code <code>${nameFlag(params.wallet)}`;
}

// Waits for a browser request: `wallet login --wait` for a connect (it finds
// the request itself), `wallet confirm --wait` for the rest.
function waitCommand(params: { wallet: string; request: string; action: OwnerAction['kind'] }) {
  return params.action === 'connect'
    ? `polygon-agent wallet login --wait${nameFlag(params.wallet)}`
    : `polygon-agent wallet confirm --request ${params.request} --wait${nameFlag(params.wallet)}`;
}

// Quotes a value for a shell command line, when it needs it.
function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

// A flag's value: shell-quoted, or `placeholder` as is (e.g. <email>).
type FlagValue = string | number | string[] | undefined | { placeholder: string };

// A suggested `polygon-agent wallet ...` command line, its values quoted.
function commandLine(params: {
  wallet: string;
  command: string;
  flags: Record<string, FlagValue>;
  // Run it with the emailed-code sign-in, whatever the picker says.
  emailSignIn?: boolean;
}): string {
  const flags = Object.entries(params.flags).flatMap(([flag, value]) => {
    if (value === undefined) return [];
    if (typeof value === 'object' && !Array.isArray(value))
      return [` --${flag} ${value.placeholder}`];
    return [value].flat().map((v) => ` --${flag} ${shellQuote(String(v))}`);
  });
  return `${params.emailSignIn ? 'POLYGON_AGENT_SIGNIN=email ' : ''}polygon-agent wallet ${params.command}${flags.join('')}${nameFlag(params.wallet)}`;
}

const EMAIL_PLACEHOLDER = { placeholder: '<email>' };

function loginEmailCommand(params: {
  wallet: string;
  email?: string;
  allowance?: number;
  days?: number;
  chains?: string;
}): string {
  return commandLine({
    wallet: params.wallet,
    command: 'login',
    flags: {
      email: params.email ?? EMAIL_PLACEHOLDER,
      allowance: params.allowance,
      days: params.days,
      chains: params.chains
    }
  });
}

function requireEmail(value: string | undefined): string {
  const email = value?.trim();
  if (!email || !EMAIL.test(email)) {
    throw new CliError({
      code: 'invalid_input',
      message: 'A valid email address is required (--email).'
    });
  }
  return email;
}

async function requireSessionWallet(wallet: string) {
  const pointer = await loadOmsWalletPointer(wallet);
  if (!pointer || pointer.access !== 'session') {
    throw new CliError({
      code: 'not_connected',
      message: `Wallet '${wallet}' isn't connected to this install.`,
      command: `polygon-agent wallet login${nameFlag(wallet)}`
    });
  }
  return pointer;
}

function nonUsd(tokens: PlanToken[]): PlanToken[] {
  return tokens.filter((token) => token.kind !== 'usd');
}

async function pricesFor(tokens: PlanToken[]): Promise<Map<string, number>> {
  try {
    return await getUsdPrices(
      nonUsd(tokens).map((token) => ({ chainId: token.chainId, address: token.address }))
    );
  } catch (error) {
    throw new CliError({
      code: 'upstream_unavailable',
      message:
        "Couldn't fetch token prices from Trails, so the limits can't be set. Try again shortly.",
      cause: error
    });
  }
}

function tokensOn(chainIds: number[]): PlanToken[] {
  return chainIds.flatMap((chainId) =>
    supportedTokens(chainId).map((token) => ({ chainId, ...token }))
  );
}

function parseChains(value: string | undefined): number[] | undefined {
  if (!value) return undefined;
  const chains = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map(requireSupportedChain);
  return [...new Set(chains)];
}

// How the owner signs in for a request: with an emailed code, or on the
// login page (the picker's choice, with its reason).
type RequestMethod = { method: 'email'; email: string } | { method: 'browser'; reason: string };

// The method for a request on a connected wallet: an emailed code with
// --email, else the picker's choice; email then needs --email or the owner's
// email from the connection. Also gives the request's email-code variant.
function starterMethod(params: {
  wallet: string;
  command: string;
  flags: Record<string, FlagValue>;
  email: string | undefined;
  ownerEmail: string | undefined;
}): { method: RequestMethod; emailCommand: string } {
  const known = params.email ?? params.ownerEmail;
  const variant = (emailSignIn: boolean) =>
    commandLine({
      wallet: params.wallet,
      command: params.command,
      flags: {
        ...params.flags,
        email: params.email ?? (known ? undefined : EMAIL_PLACEHOLDER)
      },
      emailSignIn
    });
  const emailCommand = variant(true);
  if (params.email !== undefined) {
    return { method: { method: 'email', email: requireEmail(params.email) }, emailCommand };
  }
  const picked = currentSignInMethod();
  if (picked.method === 'browser') {
    return { method: { method: 'browser', reason: picked.reason }, emailCommand };
  }
  if (!known) {
    throw new CliError({
      code: 'email_required',
      message: `This install signs in with an emailed code (${picked.reason}), and no email is known yet.`,
      hint: 'Ask the user for their email, then run `command` with it.',
      command: variant(false)
    });
  }
  return { method: { method: 'email', email: requireEmail(known) }, emailCommand };
}

// What the login page shows about the request.
function loginContext(action: OwnerAction): LoginContext {
  const purpose =
    action.kind === 'allowance-set'
      ? 'allowance'
      : action.kind === 'link-credentials'
        ? 'owner'
        : action.kind;
  const plan = 'plan' in action ? action.plan : undefined;
  return {
    purpose,
    ...(plan ? { allowanceUsd: plan.allowanceUsd, days: plan.days } : {}),
    polymarket: true
  };
}

// Best effort: the URL is in the JSON for when no browser opens here.
async function openPage(url: string): Promise<void> {
  try {
    const { default: open } = await import('open');
    await open(url);
  } catch {
    // headless host
  }
}

// Before a new request: a waiter still waiting for the sign-in of the request
// it replaces is stopped (it must not go on to approve it). A waiter whose
// owner already signed in is running its action, so the new request waits.
// Waiters are found by their pid files: the pending file goes at sign-in.
async function settleWaiters(wallet: string): Promise<void> {
  const pending = loadPending(wallet);
  const live = liveWaiters(wallet);
  const finishing = live.find((id) => pending?.id !== id);
  if (finishing) {
    throw new CliError({
      code: 'request_in_progress',
      message: 'A sign-in for this wallet is finishing.',
      hint: 'Run `command` to wait for it, then try again.',
      command: `polygon-agent wallet confirm --request ${finishing} --wait${nameFlag(wallet)}`
    });
  }
  for (const id of live) await stopWaiter(wallet, id);
}

async function startRequest(params: {
  wallet: string;
  method: RequestMethod;
  action: OwnerAction;
  shown: Record<string, unknown>;
  // This request with an emailed code, for when the browser sign-in fails.
  emailCommand: string;
}) {
  const { wallet, method, action } = params;
  if (method.method === 'email') {
    const request = await startOwnerRequest({
      wallet,
      method: 'email',
      email: method.email,
      action,
      now: new Date()
    });
    jsonOut({
      ok: true,
      status: 'code_sent',
      request: request.id,
      email: method.email,
      expiresAt: request.expiresAt,
      action: action.kind,
      ...params.shown,
      next: confirmCommand({ wallet, request: request.id }),
      hint: 'Show the user the plan above, then run `next` with the code from their email as soon as they give it. Never reuse or store the code.'
    });
    return;
  }
  const request = await startOwnerRequest({
    wallet,
    method: 'browser',
    context: loginContext(action),
    action,
    now: new Date()
  });
  if (request.method !== 'browser') throw new Error('unreachable');
  writeEmailFallback(wallet, request.id, params.emailCommand);
  spawnWaiter({ wallet, id: request.id, emailCommand: params.emailCommand });
  const url = loginPageUrl(request.relaySession);
  await openPage(url);
  jsonOut({
    ok: true,
    status: 'waiting',
    method: 'browser',
    methodReason: method.reason,
    request: request.id,
    url,
    expiresAt: request.expiresAt,
    action: action.kind,
    ...params.shown,
    next: waitCommand({ wallet, request: request.id, action: action.kind }),
    hint: 'The sign-in page is opening in the browser. Show the user the plan above and the url (in case no browser opened), ask them to sign in there, then run `next` to wait for it.'
  });
}

// --- wallet login --email (step 1 of connect) ---

// Call under the wallet lock. Throws already_connected if this install's key
// has live sessions. Only a dead or missing key means "reconnect"; anything
// else (an OMS outage) must not lead to replacing a working key.
async function refuseIfConnected(wallet: string): Promise<void> {
  if (!readRacRecord({ wallet, slot: 'rac' })) return;
  // Built inside the promise, so a missing key file (racClient throws) is
  // handled below like a dead key.
  const live = await (async () =>
    getSessions({ wallet, client: racClient({ wallet, slot: 'rac' }), fresh: true }))().catch(
    (error: unknown) => {
      if (
        error instanceof CliError &&
        (error.code === 'session_revoked' ||
          error.code === 'session_expired' ||
          error.code === 'not_connected')
      ) {
        return [];
      }
      throw error;
    }
  );
  if (live.some((session) => !session.expired)) {
    throw new CliError({
      code: 'already_connected',
      message: 'This install is already connected.',
      command: `polygon-agent wallet allowance set --amount <usd>${nameFlag(wallet)}`
    });
  }
}

// Bare `wallet login`, run by someone with an owner-mode wallet, used to sign in as the owner.
const OWNER_LOGIN_NOTE =
  'Note: `wallet login` now connects with an allowance; use `--owner` for the full owner session.\n';

// `wallet login` without --owner: connect this install with an allowance. The
// owner signs in with an emailed code (--email, or the picker says email) or
// on the login page (the picker says browser).
export async function handleSessionLogin(argv: {
  name: string;
  email?: string;
  allowance?: number;
  days?: number;
  chains?: string;
}): Promise<void> {
  try {
    const wallet = argv.name;
    const allowanceUsd = argv.allowance ?? DEFAULT_ALLOWANCE_USD;
    const days = argv.days ?? DEFAULT_DAYS;
    validateAllowance({ allowanceUsd, days });

    const pointer = await loadOmsWalletPointer(wallet);
    if (pointer && pointer.access !== 'session') {
      if (argv.email === undefined) process.stderr.write(OWNER_LOGIN_NOTE);
      throw new CliError({
        code: 'invalid_input',
        message: `Wallet '${wallet}' is signed in with --owner. Use another --name, or run: polygon-agent wallet logout${nameFlag(wallet)}`
      });
    }

    const emailCommand = loginEmailCommand({
      wallet,
      email: pointer?.email,
      allowance: argv.allowance,
      days: argv.days,
      chains: argv.chains
    });
    let method: RequestMethod;
    if (argv.email !== undefined) {
      method = { method: 'email', email: requireEmail(argv.email) };
    } else {
      const picked = currentSignInMethod();
      if (picked.method === 'browser') {
        method = { method: 'browser', reason: picked.reason };
      } else if (pointer?.email) {
        method = { method: 'email', email: requireEmail(pointer.email) };
      } else {
        throw new CliError({
          code: 'email_required',
          message: `This install signs in with an emailed code (${picked.reason}), and no email is known yet.`,
          hint: 'Ask the user for their email, then run `command` with it.',
          command: emailCommand
        });
      }
    }

    // Fail fast if already connected (checked again before the key is replaced).
    if (pointer) await withWalletKeys({ wallet, fn: () => refuseIfConnected(wallet) });

    // Default chains: Polygon and Base, plus chains already holding covered tokens.
    let chains = parseChains(argv.chains);
    if (!chains) {
      const held = new Set<number>();
      if (pointer) {
        const holdings = await walletHoldings({
          wallet,
          walletAddress: pointer.walletAddress,
          chainIds: supportedChainIds()
        }).catch(() => null);
        for (const balance of holdings?.balances ?? []) {
          if (
            BigInt(balance.balance || '0') > 0n &&
            supportedTokens(balance.chainId).some(
              (t) => t.address.toLowerCase() === balance.contractAddress.toLowerCase()
            )
          ) {
            held.add(balance.chainId);
          }
        }
      }
      chains = defaultPlanChains(held);
    }

    const tokens = tokensOn(chains);
    const plan = buildPlan({
      allowanceUsd,
      days,
      tokens,
      prices: await pricesFor(tokens),
      now: new Date()
    });

    // An earlier request's waiter must not go on to approve its plan for the key below.
    await settleWaiters(wallet);
    // A fresh session key for this connection; registering it needs no owner.
    await withWalletKeys({
      wallet,
      fn: async () => {
        // Under the same lock that replaces the key, after any interrupted
        // renewal was finished (withWalletKeys): never replace a live key.
        await refuseIfConnected(wallet);
        await retireRac({ wallet, slot: 'rac' });
        await registerRac({
          wallet,
          slot: 'rac',
          days,
          installName: installName(),
          version: cliVersion(),
          now: new Date()
        });
      }
    });

    await startRequest({
      wallet,
      method,
      action: { kind: 'connect', plan },
      shown: { plan: planSummary(plan) },
      emailCommand
    });
  } catch (error) {
    jsonFail(error);
  }
}

// --- wallet confirm (step 2 of every owner request) ---

// Also the action result before the revoke fields are known (the waiter builds it early).
type ConfirmedResult = Record<string, unknown>;

// What `wallet confirm` prints for a confirmed request, by code or by the
// waiter. A newly connected install gets its own Builder access key (Trails
// quotes) and x402 signer, like a browser login. Best effort: trades and
// payments set it up on first use if this fails.
async function confirmedJson(
  wallet: string,
  confirmed: ConfirmedResult
): Promise<Record<string, unknown>> {
  let result: Record<string, unknown> = confirmed;
  const failedOutright =
    result.connected === false || result.renewed === false || result.updated === false;
  if (result.connected === true && typeof result.walletAddress === 'string') {
    const address = result.walletAddress;
    const provision = await provisionBuilderOnce({ walletAddress: address }).catch(
      (error: unknown) => ({ provisioned: false, reason: String(error) })
    );
    result = { ...result, builderAccess: provision.provisioned || provision.reason === 'existing' };
    // An empty wallet can't do anything yet: hand the assistant the funding link.
    const funded = await isWalletFunded(wallet, address, 137);
    if (!funded) {
      result = {
        ...result,
        funding: {
          url: fundingUrl({ walletAddress: address, chainId: 137 }),
          reason: 'empty'
        }
      };
    }
    // The wallet's page, for the assistant to send. Nothing opens on its own.
    result = {
      ...result,
      dashboard: dashboardInfo({
        walletAddress: address,
        funded,
        polymarketAddress: loadAccount(wallet)?.wallet,
        credentialsToken: await mintAccessToken(wallet, LINK_TOKEN_TTL_SECONDS)
      })
    };
  }
  return { ok: !failedOutright, walletName: wallet, ...result };
}

// After an emailed-code request on a wallet whose owner email wasn't known
// (connected through the browser), keep it: the next request can use it.
async function rememberOwnerEmail(params: {
  wallet: string;
  request: OwnerContext['request'];
}): Promise<void> {
  if (params.request.method !== 'email') return;
  const pointer = await loadOmsWalletPointer(params.wallet);
  if (pointer && !pointer.email) {
    await saveOmsWalletPointer(params.wallet, { ...pointer, email: params.request.email });
  }
}

// The waiter: signs in through the login page, runs the action, and leaves
// the output for `--wait`, a failure included. The wallet lock is taken for
// the action only, not for the minutes the sign-in may take.
async function runBrowserWaiter(params: { wallet: string; id: string }): Promise<void> {
  const { wallet, id } = params;
  writePid({ wallet, id, pid: process.pid, emailCommand: waiterEmailCommand(wallet, id) });
  try {
    let json: Record<string, unknown>;
    // The result as built for the login page, reused so it is built once.
    let early: Record<string, unknown> | undefined;
    try {
      const confirmed = await confirmOwnerRequest({
        wallet,
        requestId: id,
        now: new Date(),
        // The request's own expiry caps it.
        browser: { timeoutMs: REQUEST_LIFETIME_MS },
        // The login page is told about funding once the result is known.
        doneExtras: async (result) => {
          early = await confirmedJson(wallet, result);
          return { funding: early.funding as { url: string } | undefined };
        },
        run: (context) =>
          withWalletKeys({
            wallet,
            fn: () => runOwnerAction({ context, wallet, now: new Date() })
          })
      });
      json = early
        ? {
            ...early,
            ownerSignInRevoked: confirmed.ownerSignInRevoked,
            ...(confirmed.ownerSignInRevokeError === undefined
              ? {}
              : { ownerSignInRevokeError: confirmed.ownerSignInRevokeError })
          }
        : await confirmedJson(wallet, confirmed);
    } catch (error) {
      json = errorJson(error);
    }
    await writeResult(wallet, id, json);
  } finally {
    removePid(wallet, id);
  }
}

// How long `--wait` blocks; tests shorten it.
export const waitSettings = { timeoutMs: 90_000 };

// Prints `--wait` output; a result as `wallet confirm` would have printed
// it: a failure on stderr, and exit 1 for anything not ok.
function printConfirmed(json: Record<string, unknown>): void {
  if (json.ok === false && typeof json.code === 'string') {
    console.error(JSON.stringify(json, bigintReplacer));
    process.exit(1);
  }
  jsonOut(json);
  if (json.ok === false) process.exit(1);
}

// What `--wait` prints: the result, or that it's still waiting.
async function waitForRequest(params: {
  wallet: string;
  id: string;
  next: string;
}): Promise<Record<string, unknown>> {
  const { wallet, id } = params;
  const outcome = await waitForResult({ wallet, id, timeoutMs: waitSettings.timeoutMs });
  if (outcome.state === 'waiting') {
    return {
      ok: true,
      status: 'waiting',
      next: params.next,
      hint: 'The user has not finished signing in yet. Run `next` again to keep waiting.'
    };
  }
  if (outcome.state === 'gone') {
    const command = outcome.emailCommand ?? loginEmailCommand({ wallet });
    throw new CliError({
      code: 'browser_signin_failed',
      message: 'The browser sign-in stopped without finishing.',
      hint: 'Sign in with an emailed code instead: run `command` (ask the user for their email if it shows <email>).',
      command
    });
  }
  // Printed once: the result goes as it is shown.
  deleteResult(wallet, id);
  return outcome.result;
}

// `wallet login --wait`: waits for the wallet's latest browser request.
export async function handleLoginWait(argv: { name: string }): Promise<void> {
  let json: Record<string, unknown>;
  try {
    const wallet = argv.name;
    const pending = loadPending(wallet);
    const id = pending?.method === 'browser' ? pending.id : latestWaiterRequest(wallet);
    if (!id) {
      throw new CliError({
        code: 'request_expired',
        message: `No browser sign-in is waiting for wallet '${wallet}'.`,
        hint: 'Start one only if the user still wants to connect.',
        command: `polygon-agent wallet login${nameFlag(wallet)}`
      });
    }
    json = await waitForRequest({
      wallet,
      id,
      next: `polygon-agent wallet login --wait${nameFlag(wallet)}`
    });
  } catch (error) {
    jsonFail(error);
  }
  printConfirmed(json);
}

interface ConfirmArgs {
  name: string;
  request: string;
  code?: string;
  wait: boolean;
  'browser-waiter': boolean;
}

export const confirmCommandModule: CommandModule<object, ConfirmArgs> = {
  command: 'confirm',
  describe:
    'Approve a pending owner request with the code from the email, or wait for a browser sign-in (--wait)',
  builder: (y) =>
    y
      .option('name', { type: 'string', default: 'main', describe: 'Wallet name' })
      .option('request', { type: 'string', demandOption: true, describe: 'Request id from step 1' })
      .option('code', { type: 'string', describe: 'The code from the email' })
      .option('wait', {
        type: 'boolean',
        default: false,
        describe: 'Wait for a browser sign-in to finish (up to 90 seconds per run)'
      })
      .option('browser-waiter', { type: 'boolean', default: false, hidden: true }),
  handler: async (argv) => {
    const wallet = argv.name;
    if (argv.browserWaiter) {
      await runBrowserWaiter({ wallet, id: argv.request });
      return;
    }
    if (argv.wait) {
      let waited: Record<string, unknown>;
      try {
        waited = await waitForRequest({
          wallet,
          id: argv.request,
          next: `polygon-agent wallet confirm --request ${argv.request} --wait${nameFlag(wallet)}`
        });
      } catch (error) {
        jsonFail(error);
      }
      printConfirmed(waited);
      return;
    }
    const now = new Date();
    let json: Record<string, unknown>;
    try {
      if (argv.code === undefined) {
        throw new CliError({
          code: 'invalid_input',
          message: 'Pass --code with the code from the email, or --wait for a browser sign-in.'
        });
      }
      const code = String(argv.code);
      const confirmed = await withWalletKeys({
        wallet,
        fn: () =>
          confirmOwnerRequest({
            wallet,
            requestId: argv.request,
            code,
            now,
            run: async (context) => {
              const result = await runOwnerAction({ context, wallet, now });
              await rememberOwnerEmail({ wallet, request: context.request });
              return result;
            }
          })
      });
      json = await confirmedJson(wallet, confirmed);
    } catch (error) {
      jsonFail(error);
    }
    jsonOut(json);
    if (json.ok === false) process.exit(1);
  }
};

// --- wallet status / wallet allowance (no code) ---

// What a pending owner request would approve, in one sentence.
function pendingApproves(action: OwnerAction): string {
  switch (action.kind) {
    case 'connect':
    case 'allowance-set':
    case 'renew':
      return String(planSummary(action.plan).summary);
    case 'withdraw':
      return `Send ${formatUnits(action.amount, action.decimals)} ${action.symbol} on ${chainLabel(action.chainId)} to ${action.to}, as the owner.`;
    case 'access':
      return action.revoke
        ? `Revoke access for ${action.revoke.credentialId}${action.revoke.sessionId ? ` (session ${action.revoke.sessionId})` : ''}.`
        : 'List every install and sign-in with access to the wallet.';
    case 'link-credentials':
      return LINK_CREDENTIALS_SUMMARY;
  }
}

interface PendingRequestInfo {
  request: string;
  method: 'email' | 'browser';
  action: OwnerAction['kind'];
  email?: string;
  // Browser: the login page the owner signs in on.
  url?: string;
  expiresAt: string;
  approves: string;
  next: string;
}

// A pending owner request, for `wallet status`: enough to resume it when the
// conversation has lost track of it (who has the code or the page, what it
// approves), never the sign-in state it holds.
function pendingRequestInfo(wallet: string): PendingRequestInfo | undefined {
  const pending = loadPending(wallet);
  // An unreadable expiry counts as expired.
  if (!pending || !(Date.parse(pending.expiresAt) > Date.now())) return undefined;
  const common = {
    request: pending.id,
    action: pending.action.kind,
    expiresAt: pending.expiresAt,
    approves: pendingApproves(pending.action)
  };
  if (pending.method === 'browser') {
    return {
      ...common,
      method: 'browser',
      url: loginPageUrl(pending.relaySession),
      next: waitCommand({ wallet, request: pending.id, action: pending.action.kind })
    };
  }
  return {
    ...common,
    method: 'email',
    email: pending.email,
    next: confirmCommand({ wallet, request: pending.id })
  };
}

// What to tell the agent about a pending first connect.
function pendingHint(info: PendingRequestInfo): string {
  return info.method === 'browser'
    ? `A sign-in page is already open at ${info.url}. Ask the user to finish signing in there, then run \`next\`; start a new request only if it expires.`
    : `A code was already sent to ${info.email}. Ask the user for it; start a new request only if they can't find it or it expires.`;
}

// The Polymarket account is controlled by this install, not by the allowance, so
// the status says so. Reads the stored account file only: no SDK, no network.
function polymarketStatus(wallet: string): Record<string, unknown> {
  const account = loadAccount(wallet);
  if (!account) return {};
  return {
    polymarket: {
      wallet: account.wallet,
      kind: account.kind,
      note: 'Money moved to Polymarket is controlled by this install, not by the allowance. Check it with: polymarket status'
    }
  };
}

// The wallet's agentconnect page: the fund view while it's empty.
async function walletDashboard(wallet: string, walletAddress: string): Promise<{ url: string }> {
  return dashboardInfo({
    walletAddress,
    funded: await isWalletFunded(wallet, walletAddress, 137),
    polymarketAddress: loadAccount(wallet)?.wallet,
    credentialsToken: await mintAccessToken(wallet, LINK_TOKEN_TTL_SECONDS)
  });
}

export async function sessionReport(params: {
  wallet: string;
  withVersion: boolean;
}): Promise<Record<string, unknown>> {
  const { wallet } = params;
  const pointer = await loadOmsWalletPointer(wallet);
  const version = params.withVersion ? await versionInfo() : {};
  if (!pointer) {
    // A first connect waiting for its code: resume it rather than send another.
    const pendingInfo = pendingRequestInfo(wallet);
    return {
      ok: true,
      walletName: wallet,
      connected: false,
      ...(pendingInfo
        ? {
            pendingRequest: pendingInfo,
            next: pendingInfo.next,
            hint: pendingHint(pendingInfo)
          }
        : { next: `polygon-agent wallet login${nameFlag(wallet)}` }),
      // Alert watches work without a connection.
      watches: watchStatus(new Date()),
      ...version
    };
  }
  if (pointer.access !== 'session') {
    return {
      ok: true,
      walletName: wallet,
      connected: true,
      mode: 'owner',
      walletAddress: pointer.walletAddress,
      dashboard: await walletDashboard(wallet, pointer.walletAddress),
      ...polymarketStatus(wallet),
      watches: watchStatus(new Date()),
      ...version
    };
  }

  let sessions: Awaited<ReturnType<typeof getSessions>> = [];
  let accessError: Record<string, unknown> | undefined;
  let keysPendingRevocation: string[] = [];
  try {
    sessions = await withWalletKeys({
      wallet,
      fn: async () => {
        keysPendingRevocation = await retireParkedRacs({ wallet }).catch(() =>
          parkedRacSlots(wallet).map(
            (slot) => readRacRecord({ wallet, slot })?.credentialId ?? slot
          )
        );
        return getSessions({ wallet, client: racClient({ wallet, slot: 'rac' }) });
      }
    });
  } catch (error) {
    if (
      error instanceof CliError &&
      (error.code === 'session_revoked' || error.code === 'session_expired')
    ) {
      accessError = errorJson(error);
    } else {
      throw error;
    }
  }

  // Read after the wallet lock: finishing an interrupted renewal rewrites it.
  const approved = readApprovedPlan(wallet);
  const warnings: string[] = [];
  const balances = await walletHoldings({
    wallet,
    walletAddress: pointer.walletAddress,
    chainIds: supportedChainIds()
  }).catch((error: unknown) => {
    warnings.push(
      `Couldn't read balances: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  });
  const holdings = balances ? classifyHoldings({ balances, sessions }) : [];
  const totals = allowanceTotals({ wallet, approved });
  const spent = typeof totals?.spentUsd === 'number' ? totals.spentUsd : 0;
  const alerts = accessError
    ? []
    : sessionAlerts({ sessions, approved, spent, holdings, now: new Date() });
  if (keysPendingRevocation.length > 0) {
    alerts.push({
      type: 'old_key_live',
      message: `A replaced session key of this install isn't revoked on OMS yet (${keysPendingRevocation.join(', ')}), so its sessions may still be live. It's retried automatically.`,
      key: `old_key_live:${keysPendingRevocation.join(',')}`,
      command: `polygon-agent wallet access --revoke ${keysPendingRevocation[0]}${nameFlag(wallet)}`
    });
  }

  const pendingInfo = pendingRequestInfo(wallet);

  return {
    ok: true,
    walletName: wallet,
    connected: !accessError && sessions.some((s) => !s.expired),
    mode: 'session',
    walletAddress: pointer.walletAddress,
    // From the balances read above; unreadable balances keep the dashboard view.
    dashboard: dashboardInfo({
      walletAddress: pointer.walletAddress,
      funded: balances ? holdsAnythingOn(balances, 137) : true,
      polymarketAddress: loadAccount(wallet)?.wallet,
      credentialsToken: await mintAccessToken(wallet, LINK_TOKEN_TTL_SECONDS)
    }),
    email: pointer.email,
    installName: pointer.installName,
    ...(accessError ? { access: accessError } : {}),
    allowance: totals,
    sessions: describeSessions({ sessions, approved }),
    holdings,
    alerts,
    watches: watchStatus(new Date()),
    ...polymarketStatus(wallet),
    ...(pendingInfo ? { pendingRequest: pendingInfo } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...version
  };
}

async function versionInfo(): Promise<Record<string, unknown>> {
  const version = cliVersion();
  const latestVersion = await getLatestVersion().catch(() => null);
  const updateAvailable = latestVersion
    ? isNewerVersion({ candidate: latestVersion, current: version })
    : false;
  return {
    version,
    latestVersion,
    ...(updateAvailable ? { update: { available: true, command: 'polygon-agent update' } } : {})
  };
}

interface NameArgs {
  name: string;
}

export const statusCommandModule: CommandModule<object, NameArgs> = {
  command: 'status',
  describe: 'Connection, allowance, holdings and alerts for this install (start here)',
  builder: (y) => y.option('name', { type: 'string', default: 'main', describe: 'Wallet name' }),
  handler: async (argv) => {
    try {
      jsonOut(await sessionReport({ wallet: argv.name, withVersion: true }));
    } catch (error) {
      jsonFail(error);
    }
  }
};

// --- wallet allowance set | renew (step 1) ---

interface AllowanceSetArgs {
  name: string;
  email?: string;
  amount?: number;
  add?: string[];
  chains?: string;
}

const allowanceSetCommand: CommandModule<object, AllowanceSetArgs> = {
  command: 'set',
  describe: 'Change the allowance; the owner approves it',
  builder: (y) =>
    y
      .option('name', { type: 'string', default: 'main', describe: 'Wallet name' })
      .option('email', {
        type: 'string',
        describe: "The owner's email, for a sign-in with an emailed code"
      })
      .option('amount', { type: 'number', describe: 'New allowance in USD' })
      .option('add', {
        type: 'string',
        array: true,
        describe: 'Cover another token: <token>[@<chain>]'
      })
      .option('chains', {
        type: 'string',
        describe: 'Cover more chains (comma-separated), with their supported tokens'
      }),
  handler: async (argv) => {
    try {
      const wallet = argv.name;
      const pointer = await requireSessionWallet(wallet);
      const approved = readApprovedPlan(wallet);
      if (!approved)
        throw new CliError({
          code: 'not_connected',
          message: 'No approved allowance found for this install.'
        });
      const current = approved.plan;
      const allowanceUsd = argv.amount ?? current.allowanceUsd;

      const added: PlanToken[] = [];
      const planChains = current.chains.map((chain) => chain.chainId);
      for (const value of argv.add ?? []) {
        const { token, chainId } = parseTokenAtChain({ value, defaultChainIds: planChains });
        added.push(await resolvePlanToken({ chainId, token }));
      }
      const newChains = (parseChains(argv.chains) ?? []).filter(
        (chainId) => !planChains.includes(chainId)
      );
      added.push(...tokensOn(newChains));
      if (allowanceUsd === current.allowanceUsd && added.length === 0) {
        throw new CliError({
          code: 'invalid_input',
          message: 'Nothing to change: pass --amount, --add or --chains.'
        });
      }

      const repriced =
        allowanceUsd !== current.allowanceUsd
          ? current.chains.flatMap((chain) =>
              chain.grants.map((g) => ({
                chainId: chain.chainId,
                symbol: g.symbol,
                address: g.token,
                decimals: g.decimals,
                kind: g.kind
              }))
            )
          : [];
      const plan = buildPlan({
        allowanceUsd,
        days: current.days,
        tokens: added,
        prices: await pricesFor([...added, ...repriced]),
        now: new Date(),
        current
      });
      const { method, emailCommand } = starterMethod({
        wallet,
        command: 'allowance set',
        flags: { amount: argv.amount, add: argv.add, chains: argv.chains },
        email: argv.email,
        ownerEmail: pointer.email
      });
      await settleWaiters(wallet);
      await startRequest({
        wallet,
        method,
        action: { kind: 'allowance-set', plan },
        shown: { plan: planSummary(plan), previousAllowanceUsd: current.allowanceUsd },
        emailCommand
      });
    } catch (error) {
      jsonFail(error);
    }
  }
};

interface RenewArgs {
  name: string;
  email?: string;
  days?: number;
}

const allowanceRenewCommand: CommandModule<object, RenewArgs> = {
  command: 'renew',
  describe: 'Renew the allowance for another period with a new session key; the owner approves it',
  builder: (y) =>
    y
      .option('name', { type: 'string', default: 'main', describe: 'Wallet name' })
      .option('email', {
        type: 'string',
        describe: "The owner's email, for a sign-in with an emailed code"
      })
      .option('days', {
        type: 'number',
        describe: 'New period in days (default: the current one)'
      }),
  handler: async (argv) => {
    try {
      const wallet = argv.name;
      const pointer = await requireSessionWallet(wallet);
      const approved = readApprovedPlan(wallet);
      if (!approved)
        throw new CliError({
          code: 'not_connected',
          message: 'No approved allowance found for this install.'
        });
      const days = argv.days ?? approved.plan.days;
      const tokens: PlanToken[] = approved.plan.chains.flatMap((chain) =>
        chain.grants.map((g) => ({
          chainId: chain.chainId,
          symbol: g.symbol,
          address: g.token,
          decimals: g.decimals,
          kind: g.kind
        }))
      );
      const plan: Plan = buildPlan({
        allowanceUsd: approved.plan.allowanceUsd,
        days,
        tokens,
        prices: await pricesFor(tokens),
        now: new Date()
      });
      // An earlier request's waiter must not go on to approve its plan for the key below.
      const { method, emailCommand } = starterMethod({
        wallet,
        command: 'allowance renew',
        flags: { days: argv.days },
        email: argv.email,
        ownerEmail: pointer.email
      });
      await settleWaiters(wallet);
      await withWalletKeys({
        wallet,
        fn: async () => {
          await retireRac({ wallet, slot: 'rac-next' });
          await registerRac({
            wallet,
            slot: 'rac-next',
            days,
            installName: installName(),
            version: cliVersion(),
            now: new Date()
          });
        }
      });
      await startRequest({
        wallet,
        method,
        action: { kind: 'renew', plan },
        shown: { plan: planSummary(plan) },
        emailCommand
      });
    } catch (error) {
      jsonFail(error);
    }
  }
};

export const allowanceCommandModule: CommandModule<object, NameArgs> = {
  command: 'allowance',
  describe: 'Show the allowance (or: set, renew)',
  builder: (y) =>
    y
      .option('name', { type: 'string', default: 'main', describe: 'Wallet name' })
      .command(allowanceSetCommand)
      .command(allowanceRenewCommand),
  handler: async (argv) => {
    try {
      jsonOut(await sessionReport({ wallet: argv.name, withVersion: false }));
    } catch (error) {
      jsonFail(error);
    }
  }
};

// --- wallet withdraw (step 1) ---

interface WithdrawArgs {
  name: string;
  email?: string;
  to: string;
  token: string;
  amount: string;
  chain: string;
}

export const withdrawCommandModule: CommandModule<object, WithdrawArgs> = {
  command: 'withdraw',
  describe:
    'Send tokens out of the wallet as the owner (not from the allowance); the owner approves it',
  builder: (y) =>
    y
      .option('name', { type: 'string', default: 'main', describe: 'Wallet name' })
      .option('email', {
        type: 'string',
        describe: "The owner's email, for a sign-in with an emailed code"
      })
      .option('to', { type: 'string', demandOption: true, describe: 'Destination address' })
      .option('token', { type: 'string', demandOption: true, describe: 'Token symbol or address' })
      .option('amount', {
        type: 'string',
        demandOption: true,
        describe: 'Amount in token units, e.g. 25.5'
      })
      .option('chain', { type: 'string', default: 'polygon', describe: 'Chain (same chain only)' }),
  handler: async (argv) => {
    try {
      const wallet = argv.name;
      const pointer = await requireSessionWallet(wallet);
      const chainId = requireSupportedChain(argv.chain);
      if (!isAddress(argv.to))
        throw new CliError({ code: 'invalid_input', message: `Not an address: ${argv.to}` });
      const token = await resolvePlanToken({ chainId, token: argv.token });
      const amount = parseUnits(String(argv.amount), token.decimals);
      if (amount <= 0n)
        throw new CliError({
          code: 'invalid_input',
          message: 'The amount must be greater than zero.'
        });
      const to = getAddress(argv.to);
      // Addresses that burn the tokens: nobody can withdraw them from there.
      if (/^0x0{40}$/.test(to) || to.toLowerCase() === token.address.toLowerCase()) {
        throw new CliError({
          code: 'invalid_input',
          message: `Not a withdrawal address: ${to} (${/^0x0{40}$/.test(to) ? 'the zero address' : `the ${token.symbol} contract itself`}); tokens sent there are lost.`
        });
      }
      const display = `${formatUnits(amount, token.decimals)} ${token.symbol}`;
      const { method, emailCommand } = starterMethod({
        wallet,
        command: 'withdraw',
        flags: { to, token: argv.token, amount: argv.amount, chain: argv.chain },
        email: argv.email,
        ownerEmail: pointer.email
      });
      await settleWaiters(wallet);
      await startRequest({
        wallet,
        method,
        emailCommand,
        action: {
          kind: 'withdraw',
          chainId,
          token: token.address,
          symbol: token.symbol,
          decimals: token.decimals,
          to,
          amount
        },
        shown: {
          withdraw: {
            amount: formatUnits(amount, token.decimals),
            token: token.symbol,
            tokenAddress: token.address,
            chain: chainLabel(chainId),
            to
          },
          summary: `Send ${display} on ${chainLabel(chainId)} to ${to}, as the owner. Read the address back to the user before asking for the code.`
        }
      });
    } catch (error) {
      jsonFail(error);
    }
  }
};

// --- wallet access (step 1) ---

interface AccessArgs {
  name: string;
  email?: string;
  revoke?: string;
  session?: string;
}

export const accessCommandModule: CommandModule<object, AccessArgs> = {
  command: 'access',
  describe:
    'List (or revoke) every install and sign-in with access to the wallet; the owner approves it',
  builder: (y) =>
    y
      .option('name', { type: 'string', default: 'main', describe: 'Wallet name' })
      .option('email', {
        type: 'string',
        describe: "The owner's email, for a sign-in with an emailed code"
      })
      .option('revoke', { type: 'string', describe: 'Credential id to revoke' })
      .option('session', { type: 'string', describe: 'With --revoke: only this session id' }),
  handler: async (argv) => {
    try {
      const wallet = argv.name;
      const pointer = await requireSessionWallet(wallet);
      if (argv.session && !argv.revoke) {
        throw new CliError({
          code: 'invalid_input',
          message: '--session needs --revoke <credential id>.'
        });
      }
      const revoke = argv.revoke
        ? { credentialId: argv.revoke, ...(argv.session ? { sessionId: argv.session } : {}) }
        : undefined;
      const { method, emailCommand } = starterMethod({
        wallet,
        command: 'access',
        flags: { revoke: argv.revoke, session: argv.session },
        email: argv.email,
        ownerEmail: pointer.email
      });
      await settleWaiters(wallet);
      await startRequest({
        wallet,
        method,
        emailCommand,
        action: { kind: 'access', revoke },
        shown: {
          summary: revoke
            ? `Revoke ${revoke.sessionId ? `session ${revoke.sessionId} of ` : ''}credential ${revoke.credentialId}, then list access.`
            : 'List every install and sign-in with access to the wallet.'
        }
      });
    } catch (error) {
      jsonFail(error);
    }
  }
};

// --- wallet link-credentials ---

export const LINK_CREDENTIALS_SUMMARY =
  'Link this install so it can save and use your shipping address and cards.';

interface LinkCredentialsArgs {
  name: string;
  email?: string;
}

export const linkCredentialsCommandModule: CommandModule<object, LinkCredentialsArgs> = {
  command: 'link-credentials',
  describe:
    'Link this install for saved credentials (shipping address, cards); the owner approves it with one sign-in',
  builder: (y) =>
    y.option('name', { type: 'string', default: 'main', describe: 'Wallet name' }).option('email', {
      type: 'string',
      describe: "The owner's email, for a sign-in with an emailed code"
    }),
  handler: async (argv) => {
    try {
      const wallet = argv.name;
      const pointer = await loadOmsWalletPointer(wallet);
      // Owner mode: the owner is already signed in here, so link right away.
      if (pointer && pointer.access !== 'session') {
        const owner = getOmsClient(wallet).wallet;
        if (!owner.walletAddress) {
          throw new CliError({
            code: 'not_connected',
            message: `Wallet '${wallet}' is signed out.`,
            command: `polygon-agent wallet login --owner${nameFlag(wallet)}`
          });
        }
        const credentials = await enrollAgent({
          wallet,
          owner,
          walletAddress: owner.walletAddress,
          force: true
        });
        jsonOut({ ok: credentials.enrolled, walletName: wallet, credentials });
        if (!credentials.enrolled) process.exit(1);
        return;
      }
      await requireSessionWallet(wallet);
      const { method, emailCommand } = starterMethod({
        wallet,
        command: 'link-credentials',
        flags: {},
        email: argv.email,
        ownerEmail: pointer?.email
      });
      await settleWaiters(wallet);
      await startRequest({
        wallet,
        method,
        emailCommand,
        action: { kind: 'link-credentials' },
        shown: { summary: LINK_CREDENTIALS_SUMMARY }
      });
    } catch (error) {
      jsonFail(error);
    }
  }
};

// --- wallet logout for session-mode wallets (no code) ---

export async function logoutSessionWallet(wallet: string): Promise<Record<string, unknown>> {
  const revoked: string[] = [];
  const failed: string[] = [];
  // Keys whose file is gone: nothing here can revoke them, only the owner.
  const ownerMustRevoke: string[] = [];
  await withWalletKeys({
    wallet,
    fn: async () => {
      for (const slot of ['rac', 'rac-next', ...parkedRacSlots(wallet)] as const) {
        const record = readRacRecord({ wallet, slot });
        if (!record) continue;
        // Past its lifetime, a key has no access left.
        if (Date.parse(record.expiresAt) <= Date.now()) {
          revoked.push(record.credentialId);
          continue;
        }
        if (!hasRacKey({ wallet, slot })) {
          ownerMustRevoke.push(record.credentialId);
          continue;
        }
        try {
          await racClient({ wallet, slot }).revokeCredential({ credentialId: record.credentialId });
          revoked.push(record.credentialId);
        } catch (error) {
          // A key OMS no longer accepts (expired or revoked) has no access left.
          if (httpStatus(error) === 401) {
            revoked.push(record.credentialId);
            continue;
          }
          failed.push(
            `${record.credentialId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      // Keep the key if OMS didn't confirm the revoke: it's what can revoke it later.
      if (failed.length > 0) {
        throw new CliError({
          code: 'upstream_unavailable',
          message:
            "Couldn't revoke this install's access on OMS, so nothing was removed. Try again shortly.",
          details: { revokeErrors: failed }
        });
      }
      // Still under the wallet lock, so no spend or owner request interleaves.
      removeSessionState(wallet);
      // Every waiter stops (one past its sign-in revokes it), and no result is
      // left for a later `--wait` to print.
      for (const id of liveWaiters(wallet)) await stopWaiter(wallet, id);
      clearWaiterFiles(wallet);
      await deletePending({ wallet });
      await deleteOmsWallet(wallet);
    }
  });
  if (ownerMustRevoke.length === 0) return { accessRevoked: true, revokedCredentials: revoked };
  return {
    accessRevoked: false,
    revokedCredentials: revoked,
    ownerMustRevoke,
    hint:
      `This install no longer has the key for ${ownerMustRevoke.join(', ')}, so only the owner can revoke it: ` +
      'from any OMS app the owner signs into, or by connecting again and running polygon-agent wallet access --revoke <id>. ' +
      'It expires on its own at the end of its allowance.'
  };
}

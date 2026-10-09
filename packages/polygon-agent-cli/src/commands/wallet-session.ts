// Session-mode wallet commands: connecting this install with an email code,
// the allowance, withdrawals and access, and status. Owner actions run in two
// steps (lib/owner/requests.ts); everything else needs no code.

import type { CommandModule } from 'yargs';

import { getAddress, isAddress } from 'viem';

import type { OwnerAction } from '../lib/owner/pending.ts';
import type { Plan, PlanToken } from '../lib/session/plan.ts';

import { provisionBuilderOnce } from '../lib/builder-provision.ts';
import { CliError, errorJson, httpStatus, jsonFail, jsonOut } from '../lib/errors.ts';
import { runOwnerAction } from '../lib/owner/actions.ts';
import { deletePending, loadPending } from '../lib/owner/pending.ts';
import { confirmOwnerRequest, startOwnerRequest } from '../lib/owner/requests.ts';
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
  describeSessions,
  sessionAlerts
} from '../lib/session/status.ts';
import {
  chainLabel,
  defaultPlanChains,
  supportedChainIds,
  supportedTokens
} from '../lib/session/tokens.ts';
import { deleteOmsWallet, loadOmsWalletPointer } from '../lib/storage.ts';
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
      command: `polygon-agent wallet login --email <email>${nameFlag(wallet)}`
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

async function sendCode(params: {
  wallet: string;
  email: string;
  action: OwnerAction;
  shown: Record<string, unknown>;
}) {
  const request = await startOwnerRequest({
    wallet: params.wallet,
    email: params.email,
    action: params.action,
    now: new Date()
  });
  jsonOut({
    ok: true,
    status: 'code_sent',
    request: request.id,
    email: params.email,
    expiresAt: request.expiresAt,
    action: params.action.kind,
    ...params.shown,
    next: confirmCommand({ wallet: params.wallet, request: request.id }),
    hint: 'Show the user the plan above, then run `next` with the code from their email as soon as they give it. Never reuse or store the code.'
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

export async function handleEmailLogin(argv: {
  name: string;
  email?: string;
  allowance?: number;
  days?: number;
  chains?: string;
}): Promise<void> {
  try {
    const wallet = argv.name;
    const email = requireEmail(argv.email);
    const allowanceUsd = argv.allowance ?? DEFAULT_ALLOWANCE_USD;
    const days = argv.days ?? DEFAULT_DAYS;
    validateAllowance({ allowanceUsd, days });

    const pointer = await loadOmsWalletPointer(wallet);
    if (pointer && pointer.access !== 'session') {
      throw new CliError({
        code: 'invalid_input',
        message: `Wallet '${wallet}' is signed in with the browser (owner mode). Use another --name, or run: polygon-agent wallet logout${nameFlag(wallet)}`
      });
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

    await sendCode({
      wallet,
      email,
      action: { kind: 'connect', plan },
      shown: { plan: planSummary(plan) }
    });
  } catch (error) {
    jsonFail(error);
  }
}

// --- wallet confirm (step 2 of every owner request) ---

interface ConfirmArgs {
  name: string;
  request: string;
  code: string;
}

export const confirmCommandModule: CommandModule<object, ConfirmArgs> = {
  command: 'confirm',
  describe: 'Approve a pending owner request with the code from the email',
  builder: (y) =>
    y
      .option('name', { type: 'string', default: 'main', describe: 'Wallet name' })
      .option('request', { type: 'string', demandOption: true, describe: 'Request id from step 1' })
      .option('code', { type: 'string', demandOption: true, describe: 'The code from the email' }),
  handler: async (argv) => {
    const wallet = argv.name;
    const now = new Date();
    let result: Awaited<ReturnType<typeof confirmOwnerRequest<Record<string, unknown>>>>;
    try {
      result = await withWalletKeys({
        wallet,
        fn: () =>
          confirmOwnerRequest({
            wallet,
            requestId: argv.request,
            code: String(argv.code),
            now,
            run: (context) => runOwnerAction({ context, wallet, now })
          })
      });
    } catch (error) {
      jsonFail(error);
    }
    const failedOutright =
      result.connected === false || result.renewed === false || result.updated === false;
    // A newly connected install gets its own Builder access key (Trails quotes)
    // and x402 signer, like a browser login. Best effort: trades and payments
    // set it up on first use if this fails.
    if (result.connected === true && typeof result.walletAddress === 'string') {
      const provision = await provisionBuilderOnce({ walletAddress: result.walletAddress }).catch(
        (error: unknown) => ({ provisioned: false, reason: String(error) })
      );
      result = {
        ...result,
        builderAccess: provision.provisioned || provision.reason === 'existing'
      };
    }
    jsonOut({ ok: !failedOutright, walletName: wallet, ...result });
    if (failedOutright) process.exit(1);
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
  }
}

interface PendingRequestInfo {
  request: string;
  action: OwnerAction['kind'];
  email: string;
  expiresAt: string;
  approves: string;
  next: string;
}

// A pending owner request, for `wallet status`: enough to resume it when the
// conversation has lost track of it (who has the code, what it approves),
// never the sign-in state it holds.
function pendingRequestInfo(wallet: string): PendingRequestInfo | undefined {
  const pending = loadPending(wallet);
  // An unreadable expiry counts as expired.
  if (!pending || !(Date.parse(pending.expiresAt) > Date.now())) return undefined;
  return {
    request: pending.id,
    action: pending.action.kind,
    email: pending.email,
    expiresAt: pending.expiresAt,
    approves: pendingApproves(pending.action),
    next: confirmCommand({ wallet, request: pending.id })
  };
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
            hint: `A code was already sent to ${pendingInfo.email}. Ask the user for it; start a new request only if they can't find it or it expires.`
          }
        : { next: `polygon-agent wallet login --email <email>${nameFlag(wallet)}` }),
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
  amount?: number;
  add?: string[];
  chains?: string;
}

const allowanceSetCommand: CommandModule<object, AllowanceSetArgs> = {
  command: 'set',
  describe: 'Change the allowance (amount, tokens, chains); sends a code to the owner',
  builder: (y) =>
    y
      .option('name', { type: 'string', default: 'main', describe: 'Wallet name' })
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
      await sendCode({
        wallet,
        email: requireEmail(pointer.email),
        action: { kind: 'allowance-set', plan },
        shown: { plan: planSummary(plan), previousAllowanceUsd: current.allowanceUsd }
      });
    } catch (error) {
      jsonFail(error);
    }
  }
};

interface RenewArgs {
  name: string;
  days?: number;
}

const allowanceRenewCommand: CommandModule<object, RenewArgs> = {
  command: 'renew',
  describe:
    'Renew the allowance for another period with a new session key; sends a code to the owner',
  builder: (y) =>
    y.option('name', { type: 'string', default: 'main', describe: 'Wallet name' }).option('days', {
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
      await sendCode({
        wallet,
        email: requireEmail(pointer.email),
        action: { kind: 'renew', plan },
        shown: { plan: planSummary(plan) }
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
  to: string;
  token: string;
  amount: string;
  chain: string;
}

export const withdrawCommandModule: CommandModule<object, WithdrawArgs> = {
  command: 'withdraw',
  describe:
    'Send tokens out of the wallet as the owner (not from the allowance); sends a code to the owner',
  builder: (y) =>
    y
      .option('name', { type: 'string', default: 'main', describe: 'Wallet name' })
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
      const display = `${formatUnits(amount, token.decimals)} ${token.symbol}`;
      await sendCode({
        wallet,
        email: requireEmail(pointer.email),
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
  revoke?: string;
  session?: string;
}

export const accessCommandModule: CommandModule<object, AccessArgs> = {
  command: 'access',
  describe:
    'List (or revoke) every install and sign-in with access to the wallet; sends a code to the owner',
  builder: (y) =>
    y
      .option('name', { type: 'string', default: 'main', describe: 'Wallet name' })
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
      await sendCode({
        wallet,
        email: requireEmail(pointer.email),
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

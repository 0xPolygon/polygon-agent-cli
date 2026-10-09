// What step 2 does once the owner is signed in. Runs under the wallet lock.

import { encodeFunctionData, erc20Abi } from 'viem';

import type {
  AccessGrant,
  OMSWallet,
  SmartSessionGrant,
  SmartSessionGrantUsage
} from '@polygonlabs/oms-wallet';

import { findNetworkById, TransactionMode } from '@polygonlabs/oms-wallet';

import type { Plan, PlanChain } from '../session/plan.ts';
import type { RacSlot } from '../session/rac.ts';
import type { OwnerContext } from './requests.ts';

import { CliError, mapOmsError } from '../errors.ts';
import { makeFeeSelector } from '../oms-tx.ts';
import { resetLedger } from '../session/ledger.ts';
import { planSummary, toGrants } from '../session/plan.ts';
import { racClient, readRacRecord, retireParkedRacs, retireRac } from '../session/rac.ts';
import { commitRenewal } from '../session/renewal.ts';
import { invalidateSessions } from '../session/sessions.ts';
import { readApprovedPlan, writeApprovedPlan } from '../session/state.ts';
import { chainLabel, findSupportedToken } from '../session/tokens.ts';
import { probeSponsorship } from '../session/transfer.ts';
import { saveOmsWalletPointer } from '../storage.ts';
import { formatUnits, getExplorerUrl, resolveNetwork } from '../utils.ts';

interface ApprovedChain {
  chainId: number;
  sessionId: string;
  walletId: string;
}

interface FailedChain {
  chainId: number;
  chain: string;
  code: string;
  error: string;
}

function failure(params: { chainId: number; code: string; error: unknown }): FailedChain {
  return {
    chainId: params.chainId,
    chain: chainLabel(params.chainId),
    code: params.code,
    error: params.error instanceof Error ? params.error.message : String(params.error)
  };
}

// One authorizeRemoteAccess per chain; a failure on one chain doesn't stop the rest.
async function approveChains(params: {
  owner: OMSWallet;
  credentialId: string;
  plan: Plan;
  reuseSessions: boolean;
}): Promise<{ approved: ApprovedChain[]; failed: FailedChain[] }> {
  const approved: ApprovedChain[] = [];
  const failed: FailedChain[] = [];
  for (const chain of params.plan.chains) {
    const network = findNetworkById(chain.chainId);
    if (!network) {
      failed.push(
        failure({ chainId: chain.chainId, code: 'not_covered', error: 'unsupported chain' })
      );
      continue;
    }
    try {
      const result = await params.owner.wallet.authorizeRemoteAccess({
        credentialId: params.credentialId,
        network,
        grants: toGrants(chain),
        expiresAt: params.plan.expiresAt,
        ...(params.reuseSessions && chain.sessionId ? { sessionId: chain.sessionId } : {})
      });
      approved.push({
        chainId: chain.chainId,
        sessionId: result.sessionId,
        walletId: result.walletId
      });
    } catch (error) {
      const mapped = mapOmsError(error);
      const code = mapped instanceof CliError ? mapped.code : 'upstream_error';
      failed.push(failure({ chainId: chain.chainId, code, error: mapped }));
    }
  }
  return { approved, failed };
}

// A session matches the plan only if it holds exactly the planned grants:
// cumulative, any-recipient ERC-20 limits and nothing else, until the planned
// expiry (OMS stores it to the second).
export function sessionMatchesPlan(params: {
  session: { chainId: number; expiresAt: string; grants: ReadonlyArray<SmartSessionGrant> };
  planned: PlanChain;
  expiresAt: string;
}): boolean {
  const { session, planned } = params;
  if (session.chainId !== planned.chainId) return false;
  if (Math.abs(Date.parse(session.expiresAt) - Date.parse(params.expiresAt)) > 1000) return false;
  if (session.grants.length !== planned.grants.length) return false;
  return planned.grants.every((grant) =>
    session.grants.some(
      (g) =>
        g.kind === 'erc20Transfer' &&
        g.token.toLowerCase() === grant.token.toLowerCase() &&
        g.limit === grant.limit &&
        g.to === undefined &&
        g.cumulative === true
    )
  );
}

// Reads the approved sessions back through the session key, checks each one is
// exactly what step 1 showed, and (for chains in `probe`) checks gas
// sponsorship. A chain that fails either is revoked while the owner is still
// signed in; if the check itself can't run, every approved session is.
async function verifyAndProbe(params: {
  wallet: string;
  slot: RacSlot;
  owner: OMSWallet;
  credentialId: string;
  walletAddress: string;
  plan: Plan;
  approved: ApprovedChain[];
  probe: Set<number>;
}): Promise<{
  approved: ApprovedChain[];
  failed: FailedChain[];
  warnings: string[];
  revoked: Set<number>;
}> {
  const client = racClient({ wallet: params.wallet, slot: params.slot });
  const kept: ApprovedChain[] = [];
  const failed: FailedChain[] = [];
  const warnings: string[] = [];
  const revoked = new Set<number>();

  const revoke = async (chain: ApprovedChain) => {
    revoked.add(chain.chainId);
    await params.owner.wallet
      .revokeAccess({ credentialId: params.credentialId, sessionId: chain.sessionId })
      .catch((error: unknown) =>
        warnings.push(
          `Could not revoke the session on ${chainLabel(chain.chainId)}: ${String(error)}`
        )
      );
  };

  let listed: Awaited<ReturnType<typeof client.listSessions>>;
  try {
    listed = await client.listSessions();
  } catch (error) {
    for (const chain of params.approved) await revoke(chain);
    throw new CliError({
      code: 'upstream_unavailable',
      message:
        "Couldn't read the approved sessions back to check them, so they were revoked. Nothing changed; try again.",
      details: { warnings },
      cause: error
    });
  }

  for (const chain of params.approved) {
    const planned = params.plan.chains.find((c) => c.chainId === chain.chainId);
    const session = listed.find((s) => s.sessionId === chain.sessionId);
    if (
      !planned ||
      !session ||
      !sessionMatchesPlan({ session, planned, expiresAt: params.plan.expiresAt })
    ) {
      await revoke(chain);
      failed.push(
        failure({
          chainId: chain.chainId,
          code: 'upstream_error',
          error: 'the approved session did not match the plan, so it was revoked'
        })
      );
      continue;
    }

    if (params.probe.has(chain.chainId)) {
      const token = (planned.grants.find((g) => g.kind === 'usd') ?? planned.grants[0]).token;
      const probe = await probeSponsorship({
        client,
        walletId: chain.walletId,
        sessionId: chain.sessionId,
        chainId: chain.chainId,
        token,
        walletAddress: params.walletAddress
      });
      if (probe.sponsored === false) {
        await revoke(chain);
        failed.push(
          failure({
            chainId: chain.chainId,
            code: 'not_sponsored',
            error: `OMS doesn't sponsor gas for session transfers on ${chainLabel(chain.chainId)}, so it was left out`
          })
        );
        continue;
      }
      if (probe.sponsored === null) {
        warnings.push(
          `Couldn't check gas sponsorship on ${chainLabel(chain.chainId)} (${probe.error}); transfers there will say if it's missing.`
        );
      }
    }
    kept.push(chain);
  }
  return { approved: kept, failed, warnings, revoked };
}

// The plan as approved: only chains that made it, each with its session id.
function approvedPlan(params: { plan: Plan; approved: ApprovedChain[]; keep?: PlanChain[] }): Plan {
  const chains: PlanChain[] = [];
  for (const chain of params.plan.chains) {
    const ok = params.approved.find((a) => a.chainId === chain.chainId);
    if (ok) {
      chains.push({ ...chain, sessionId: ok.sessionId });
      continue;
    }
    const previous = params.keep?.find((c) => c.chainId === chain.chainId);
    if (previous) chains.push(previous);
  }
  return { ...params.plan, chains };
}

function worstCase(plan: Plan): string {
  const usd = `$${plan.allowanceUsd.toLocaleString('en-US')}`;
  return (
    `If this install were compromised, up to ${usd} worth of each covered token on each covered chain ` +
    `could be moved out until ${plan.expiresAt.slice(0, 10)}. With mostly one token in the wallet, that's about ${usd}. ` +
    'Revoke access any time with: polygon-agent wallet access --revoke <id>.'
  );
}

async function connect(params: { context: OwnerContext; wallet: string; plan: Plan; now: Date }) {
  const { owner, walletAddress, request } = params.context;
  const rac = readRacRecord({ wallet: params.wallet, slot: 'rac' });
  if (!rac) {
    throw new CliError({
      code: 'request_expired',
      message: "This install's session key from step 1 is missing; start again."
    });
  }

  const approval = await approveChains({
    owner,
    credentialId: rac.credentialId,
    plan: params.plan,
    reuseSessions: false
  });
  const checked = await verifyAndProbe({
    wallet: params.wallet,
    slot: 'rac',
    owner,
    credentialId: rac.credentialId,
    walletAddress,
    plan: params.plan,
    approved: approval.approved,
    probe: new Set(approval.approved.map((a) => a.chainId))
  });
  const failed = [...approval.failed, ...checked.failed];
  if (checked.approved.length === 0) {
    return { connected: false, walletAddress, approved: [], failed, warnings: checked.warnings };
  }

  const plan = approvedPlan({ plan: params.plan, approved: checked.approved });
  await saveOmsWalletPointer(params.wallet, {
    walletAddress,
    loginMethod: 'email',
    createdAt: params.now.toISOString(),
    access: 'session',
    email: request.email,
    installName: rac.installName
  });
  writeApprovedPlan({
    wallet: params.wallet,
    approved: { plan, approvedAt: params.now.toISOString() }
  });
  resetLedger(params.wallet);
  invalidateSessions(params.wallet);
  return {
    connected: true,
    walletAddress,
    installName: rac.installName,
    allowance: planSummary(plan),
    failed,
    warnings: checked.warnings,
    worstCase: worstCase(plan)
  };
}

async function allowanceSet(params: {
  context: OwnerContext;
  wallet: string;
  plan: Plan;
  now: Date;
}) {
  const { owner, walletAddress } = params.context;
  const rac = readRacRecord({ wallet: params.wallet, slot: 'rac' });
  if (!rac)
    throw new CliError({ code: 'not_connected', message: 'This install is not connected.' });
  const current = readApprovedPlan(params.wallet);

  const approval = await approveChains({
    owner,
    credentialId: rac.credentialId,
    plan: params.plan,
    reuseSessions: true
  });
  const newChains = new Set(
    params.plan.chains.filter((chain) => !chain.sessionId).map((chain) => chain.chainId)
  );
  const checked = await verifyAndProbe({
    wallet: params.wallet,
    slot: 'rac',
    owner,
    credentialId: rac.credentialId,
    walletAddress,
    plan: params.plan,
    approved: approval.approved,
    probe: newChains
  });
  const failed = [...approval.failed, ...checked.failed];
  // Nothing approved: the allowance and the USD total stay as they were.
  if (checked.approved.length === 0) {
    return { updated: false, failed, warnings: checked.warnings };
  }
  // A chain whose re-approval failed keeps its old session and limits, unless
  // its session was revoked during the check.
  const plan = approvedPlan({
    plan: params.plan,
    approved: checked.approved,
    keep: current?.plan.chains.filter((chain) => !checked.revoked.has(chain.chainId))
  });
  writeApprovedPlan({
    wallet: params.wallet,
    approved: { plan, approvedAt: params.now.toISOString() }
  });
  resetLedger(params.wallet);
  invalidateSessions(params.wallet);
  return {
    updated: true,
    allowance: planSummary(plan),
    failed,
    warnings: checked.warnings
  };
}

async function renew(params: { context: OwnerContext; wallet: string; plan: Plan; now: Date }) {
  const { owner, walletAddress } = params.context;
  const next = readRacRecord({ wallet: params.wallet, slot: 'rac-next' });
  if (!next) {
    throw new CliError({
      code: 'request_expired',
      message: 'The new session key from step 1 is missing; start again.'
    });
  }

  const approval = await approveChains({
    owner,
    credentialId: next.credentialId,
    plan: params.plan,
    reuseSessions: false
  });
  // If the new key ends up unused, retire it (parked until OMS confirms).
  const dropNext = async () => {
    await retireRac({ wallet: params.wallet, slot: 'rac-next', owner: owner.wallet });
  };
  let checked: Awaited<ReturnType<typeof verifyAndProbe>>;
  try {
    checked = await verifyAndProbe({
      wallet: params.wallet,
      slot: 'rac-next',
      owner,
      credentialId: next.credentialId,
      walletAddress,
      plan: params.plan,
      approved: approval.approved,
      probe: new Set()
    });
  } catch (error) {
    await dropNext();
    throw error;
  }
  const failed = [...approval.failed, ...checked.failed];
  if (checked.approved.length === 0) {
    await dropNext();
    return { renewed: false, failed, warnings: checked.warnings };
  }

  // Switch to the new key (recorded first, so a crash part-way is finished
  // by the next command). The old key is retired from the key itself, else as
  // the owner; if OMS confirms neither, it stays parked (its sessions may still
  // be live) and every later spend, status and owner request retries it.
  const warnings = [...checked.warnings];
  const plan = approvedPlan({ plan: params.plan, approved: checked.approved });
  const oldPending = await commitRenewal({
    wallet: params.wallet,
    approved: { plan, approvedAt: params.now.toISOString() },
    owner: owner.wallet
  });
  if (oldPending) {
    warnings.push(
      `Couldn't revoke the previous session key (${oldPending}), so its sessions may still be live. ` +
        "It's kept and retried automatically; to cut it off now: polygon-agent wallet access --revoke " +
        oldPending
    );
  }
  return {
    renewed: true,
    previousKeyRetired: oldPending === null,
    allowance: planSummary(plan),
    failed,
    warnings
  };
}

async function withdraw(params: {
  context: OwnerContext;
  wallet: string;
  action: Extract<OwnerContext['request']['action'], { kind: 'withdraw' }>;
}) {
  const { owner } = params.context;
  const { action } = params;
  const network = findNetworkById(action.chainId);
  if (!network)
    throw new CliError({
      code: 'invalid_input',
      message: `Chain ${action.chainId} isn't supported.`
    });
  const res = await owner.wallet.sendTransaction({
    network,
    to: action.token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [action.to, action.amount]
    }),
    value: 0n,
    mode: TransactionMode.Relayer,
    waitForStatus: true,
    selectFeeOption: makeFeeSelector(false)
  });
  return {
    withdrawn: true,
    amount: formatUnits(action.amount, action.decimals),
    token: action.symbol,
    chain: chainLabel(action.chainId),
    to: action.to,
    txHash: res.txnHash,
    ...(res.txnHash
      ? { explorerUrl: getExplorerUrl(resolveNetwork(action.chainId), res.txnHash) }
      : {})
  };
}

function sameGrant(a: SmartSessionGrant, b: SmartSessionGrant): boolean {
  const sameTo = (a.to ?? '').toLowerCase() === (b.to ?? '').toLowerCase();
  if (a.kind === 'erc20Transfer' && b.kind === 'erc20Transfer') {
    return a.token.toLowerCase() === b.token.toLowerCase() && sameTo;
  }
  return a.kind === 'nativeTransfer' && b.kind === 'nativeTransfer' && sameTo;
}

// One grant's limit and use, in token units when the token is a known one.
function describeGrant(params: {
  chainId?: number;
  grant: SmartSessionGrant;
  usage?: ReadonlyArray<SmartSessionGrantUsage>;
}): Record<string, unknown> {
  const { grant } = params;
  const used = params.usage?.find((u) => sameGrant(u.grant, grant))?.used;
  const known =
    grant.kind === 'erc20Transfer' && params.chainId !== undefined
      ? findSupportedToken({ chainId: params.chainId, address: grant.token })
      : undefined;
  const amount = (value: bigint) => (known ? formatUnits(value, known.decimals) : value.toString());
  // A per-transaction limit (another app's grant) has no running total.
  const perTransaction = grant.kind === 'erc20Transfer' && grant.cumulative === false;
  return {
    ...(grant.kind === 'erc20Transfer'
      ? { token: grant.token, ...(known ? { symbol: known.symbol } : {}) }
      : { native: true }),
    limit: amount(grant.limit),
    ...(perTransaction ? { perTransaction: true } : {}),
    ...(used === undefined || perTransaction
      ? {}
      : { used: amount(used), remaining: amount(grant.limit > used ? grant.limit - used : 0n) }),
    to: grant.to ?? 'any'
  };
}

// An access grant as the owner sees it. For an install's session this reads
// the session (chain, expiry) and its usage, so the owner can judge what is
// still exposed; if those reads fail, the grant is still listed, marked so.
async function describeAccess(params: {
  owner: OMSWallet;
  grant: AccessGrant;
  installCredentialId?: string;
}): Promise<Record<string, unknown>> {
  const { grant } = params;
  const common = {
    type: grant.type,
    credentialId: grant.credentialId,
    expiresAt: grant.expiresAt,
    isThisSignIn: grant.isCaller,
    isThisInstall: grant.credentialId === params.installCredentialId
  };
  if (grant.type === 'direct') return { ...common, app: 'Owner sign-in' };
  const remote = {
    ...common,
    sessionId: grant.sessionId,
    app: grant.metadata.appName || grant.metadata.appUrl || 'Unnamed app'
  };
  try {
    const session = await params.owner.wallet.getRemoteAccessSession({
      sessionId: grant.sessionId
    });
    const network = findNetworkById(session.chainId);
    const usage = network
      ? await params.owner.wallet.getRemoteAccessSessionUsage({
          sessionId: grant.sessionId,
          network
        })
      : undefined;
    return {
      ...remote,
      chainId: session.chainId,
      chain: chainLabel(session.chainId),
      sessionExpiresAt: session.expiresAt,
      tokens: session.grants.map((g) =>
        describeGrant({ chainId: session.chainId, grant: g, usage })
      )
    };
  } catch (error) {
    return {
      ...remote,
      tokens: grant.grants.map((g) => describeGrant({ grant: g })),
      detailsError: `Couldn't read this session's chain and usage: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

async function access(params: {
  context: OwnerContext;
  wallet: string;
  revoke?: { credentialId: string; sessionId?: string };
}) {
  const { owner } = params.context;
  const installCredentialId = readRacRecord({ wallet: params.wallet, slot: 'rac' })?.credentialId;
  let revoked: Record<string, unknown> | undefined;
  if (params.revoke) {
    await owner.wallet.revokeAccess(params.revoke);
    revoked = {
      ...params.revoke,
      wasThisInstall: params.revoke.credentialId === installCredentialId
    };
  }
  const grants = await owner.wallet.listAccess();
  const described: Record<string, unknown>[] = [];
  for (const grant of grants) {
    described.push(await describeAccess({ owner, grant, installCredentialId }));
  }
  return {
    ...(revoked ? { revoked } : {}),
    access: described
  };
}

async function runAction(params: {
  context: OwnerContext;
  wallet: string;
  now: Date;
}): Promise<Record<string, unknown>> {
  const { action } = params.context.request;
  switch (action.kind) {
    case 'connect':
      return { action: 'connect', ...(await connect({ ...params, plan: action.plan })) };
    case 'allowance-set':
      return { action: 'allowance-set', ...(await allowanceSet({ ...params, plan: action.plan })) };
    case 'renew':
      return { action: 'renew', ...(await renew({ ...params, plan: action.plan })) };
    case 'withdraw':
      return { action: 'withdraw', ...(await withdraw({ ...params, action })) };
    case 'access':
      return { action: 'access', ...(await access({ ...params, revoke: action.revoke })) };
  }
}

export async function runOwnerAction(params: {
  context: OwnerContext;
  wallet: string;
  now: Date;
}): Promise<Record<string, unknown>> {
  const result = await runAction(params);
  // While the owner is signed in, retry any replaced key OMS hasn't revoked
  // yet. Best effort: the action itself is done either way.
  const pending = await retireParkedRacs({
    wallet: params.wallet,
    owner: params.context.owner.wallet
  }).catch((error: unknown) => [
    `retry failed: ${error instanceof Error ? error.message : String(error)}`
  ]);
  return pending.length > 0 ? { ...result, keysPendingRevocation: pending } : result;
}

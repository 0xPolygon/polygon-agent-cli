// Setting up a connection's allowance while the owner is signed in on the
// connect page: plan it, give the connection its own key, approve the plan for
// that key on each chain as the owner, and keep only what checks out. The same
// steps as the CLI's `wallet login` (owner/actions.ts), for a key the worker
// holds instead of one on the agent's machine.

import type { OMSWallet } from '@polygonlabs/oms-wallet';

import { findNetworkById } from '@polygonlabs/oms-wallet';

import type { ApprovedChain, KeyRecord, KeyRequest, KeyResponse } from './agent-key.ts';

import { mapOmsError, MoneyError } from './errors.ts';
import { buildPlan, planTokens, planToJson, toGrants, validateAllowance } from './plan.ts';
import { chainLabel, findSupportedToken, supportedChainIds } from './tokens.ts';

export interface AllowanceDeps {
  owner: Pick<OMSWallet['wallet'], 'authorizeRemoteAccess' | 'revokeAccess'>;
  indexer: Pick<OMSWallet['indexer'], 'getBalances'>;
  // USD prices by priceKey, for the tokens that aren't dollars.
  prices: (tokens: { chainId: number; address: string }[]) => Promise<Map<string, number>>;
  // The new connection's key (its Durable Object).
  key: (req: KeyRequest) => Promise<KeyResponse>;
  now: () => Date;
}

export interface AllowanceSetUp {
  allowanceUsd: number;
  days: number;
  expiresAt: string;
  chains: string[];
  // Chains left out (not approved, or no sponsored gas), with why.
  skipped: { chain: string; reason: string }[];
}

async function keyCall<T>(deps: AllowanceDeps, req: KeyRequest): Promise<T> {
  const res = await deps.key(req);
  if (!res.ok) {
    throw new MoneyError({
      code: res.error.code,
      message: res.error.error,
      hint: res.error.hint
    });
  }
  return res.value as T;
}

/** Chains where the wallet holds a covered token (the plan adds them to Polygon and Base). */
async function heldChains(deps: AllowanceDeps, wallet: string): Promise<number[]> {
  const networks = supportedChainIds()
    .map((chainId) => findNetworkById(chainId))
    .filter((network) => network !== undefined);
  try {
    const res = await deps.indexer.getBalances({ walletAddress: wallet, networks });
    return res.balances
      .filter(
        (b) =>
          BigInt(b.balance) > 0n &&
          findSupportedToken({ chainId: b.chainId, address: b.contractAddress }) !== undefined
      )
      .map((b) => b.chainId);
  } catch {
    // Without balances, the plan still covers Polygon and Base.
    return [];
  }
}

export async function setUpAllowance(params: {
  wallet: string;
  appName: string;
  allowanceUsd: number;
  days: number;
  deps: AllowanceDeps;
}): Promise<AllowanceSetUp> {
  const { deps } = params;
  validateAllowance(params);
  const held = await heldChains(deps, params.wallet);
  const priced = planTokens(held).filter((token) => token.kind !== 'usd');
  const plan = buildPlan({
    allowanceUsd: params.allowanceUsd,
    days: params.days,
    heldChainIds: held,
    prices: await deps.prices(priced.map((t) => ({ chainId: t.chainId, address: t.address }))),
    now: deps.now()
  });

  const record = await keyCall<KeyRecord>(deps, {
    op: 'register',
    wallet: params.wallet,
    days: params.days,
    appName: params.appName
  });

  // One approval per chain; a failure on one chain doesn't stop the rest.
  const approved: ApprovedChain[] = [];
  const skipped: { chain: string; reason: string }[] = [];
  for (const chain of plan.chains) {
    const network = findNetworkById(chain.chainId);
    if (!network) continue;
    try {
      const result = await deps.owner.authorizeRemoteAccess({
        credentialId: record.credentialId,
        network,
        grants: toGrants(chain),
        expiresAt: plan.expiresAt
      });
      approved.push({
        chainId: chain.chainId,
        sessionId: result.sessionId,
        walletId: result.walletId
      });
    } catch (error) {
      const mapped = mapOmsError(error);
      skipped.push({
        chain: chainLabel(chain.chainId),
        reason: mapped instanceof Error ? mapped.message : String(mapped)
      });
    }
  }

  // Read back through the key and checked; whatever doesn't match is revoked
  // while the owner is still signed in.
  const checked = approved.length
    ? await keyCall<{ kept: ApprovedChain[]; dropped: { chainId: number; reason: string }[] }>(
        deps,
        { op: 'approve', wallet: params.wallet, plan: planToJson(plan), approved }
      )
    : { kept: [], dropped: [] };
  for (const drop of checked.dropped) {
    const session = approved.find((a) => a.chainId === drop.chainId);
    if (session) {
      await deps.owner
        .revokeAccess({ credentialId: record.credentialId, sessionId: session.sessionId })
        .catch(() => undefined);
    }
    skipped.push({ chain: chainLabel(drop.chainId), reason: drop.reason });
  }

  if (checked.kept.length === 0) {
    await deps.key({ op: 'revoke', wallet: params.wallet }).catch(() => undefined);
    await deps.owner.revokeAccess({ credentialId: record.credentialId }).catch(() => undefined);
    throw new MoneyError({
      code: 'upstream_unavailable',
      message: "The allowance couldn't be set up on any chain, so nothing was approved. Try again.",
      details: { skipped }
    });
  }

  return {
    allowanceUsd: plan.allowanceUsd,
    days: plan.days,
    expiresAt: plan.expiresAt,
    chains: checked.kept.map((k) => chainLabel(k.chainId)),
    skipped
  };
}

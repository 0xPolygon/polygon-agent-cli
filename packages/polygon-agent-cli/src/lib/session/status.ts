// What `wallet status` and `wallet allowance` report for a session-mode wallet:
// the live sessions and their limits, the USD total against the allowance,
// what the wallet holds and whether the agent can spend it, and alerts.

import type { BalancesResult } from '@polygonlabs/oms-wallet';

import type { LiveSession } from './sessions.ts';
import type { ApprovedPlan } from './state.ts';

import { formatUnits } from '../utils.ts';
import { chainLabel, findSupportedToken, supportedChainIds } from './tokens.ts';
import { spentUsdSince } from './transfer.ts';

export interface Alert {
  type:
    | 'expired'
    | 'expiring'
    | 'allowance_low'
    | 'limit_used'
    | 'uncovered_funds'
    | 'old_key_live';
  message: string;
  command?: string;
}

const DAY_MS = 86_400_000;
const LOW_ALLOWANCE_SHARE = 0.2;

export function describeSessions(params: {
  sessions: LiveSession[];
  approved: ApprovedPlan | null;
}): Record<string, unknown>[] {
  return params.sessions.map((session) => {
    const planned = params.approved?.plan.chains.find((c) => c.chainId === session.chainId);
    return {
      chain: chainLabel(session.chainId),
      chainId: session.chainId,
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      expired: session.expired,
      tokens: session.grants.map((grant) => {
        const known =
          planned?.grants.find((g) => g.token.toLowerCase() === grant.token.toLowerCase()) ??
          findSupportedToken({ chainId: session.chainId, address: grant.token });
        const decimals = known?.decimals ?? 18;
        const fmt = (value: bigint | null) =>
          value === null ? null : formatUnits(value, decimals);
        return {
          symbol: known?.symbol ?? grant.token,
          token: grant.token,
          limit: fmt(grant.limit),
          used: fmt(grant.used),
          remaining: fmt(grant.remaining)
        };
      })
    };
  });
}

interface Holding {
  chain: string;
  chainId: number;
  symbol: string;
  token?: string;
  balance: string;
  usd?: number;
  status: 'covered' | 'limit_used' | 'not_covered' | 'native_not_spendable';
}

// Every non-zero balance on the supported chains, and whether the sessions cover it.
export function classifyHoldings(params: {
  balances: BalancesResult;
  sessions: LiveSession[];
}): Holding[] {
  const holdings: Holding[] = [];
  const supported = new Set(supportedChainIds());
  for (const native of params.balances.nativeBalances) {
    if (!supported.has(native.chainId) || BigInt(native.balance || '0') === 0n) continue;
    holdings.push({
      chain: chainLabel(native.chainId),
      chainId: native.chainId,
      symbol: native.symbol,
      balance: formatUnits(BigInt(native.balance), 18),
      usd: native.balanceUSD ? Number(native.balanceUSD) : undefined,
      status: 'native_not_spendable'
    });
  }
  for (const balance of params.balances.balances) {
    if (!supported.has(balance.chainId) || BigInt(balance.balance || '0') === 0n) continue;
    const known = findSupportedToken({
      chainId: balance.chainId,
      address: balance.contractAddress
    });
    const grant = params.sessions
      .filter((s) => s.chainId === balance.chainId && !s.expired)
      .flatMap((s) => s.grants)
      .find((g) => g.token.toLowerCase() === balance.contractAddress.toLowerCase());
    const decimals = balance.contractInfo?.decimals ?? known?.decimals ?? 18;
    holdings.push({
      chain: chainLabel(balance.chainId),
      chainId: balance.chainId,
      symbol: balance.contractInfo?.symbol ?? known?.symbol ?? 'ERC20',
      token: balance.contractAddress,
      balance: formatUnits(BigInt(balance.balance), decimals),
      usd: balance.balanceUSD ? Number(balance.balanceUSD) : undefined,
      status: !grant ? 'not_covered' : grant.remaining === 0n ? 'limit_used' : 'covered'
    });
  }
  return holdings;
}

export function sessionAlerts(params: {
  sessions: LiveSession[];
  approved: ApprovedPlan | null;
  spent: number;
  holdings: Holding[];
  now: Date;
}): Alert[] {
  const alerts: Alert[] = [];
  const live = params.sessions.filter((s) => !s.expired);
  if (params.sessions.length > 0 && live.length === 0) {
    alerts.push({
      type: 'expired',
      message: 'The allowance has expired; spending is paused.',
      command: 'polygon-agent wallet allowance renew'
    });
  } else if (live.length > 0) {
    const soonest = Math.min(...live.map((s) => Date.parse(s.expiresAt)));
    const left = soonest - params.now.getTime();
    if (left <= 7 * DAY_MS) {
      const days = Math.max(0, Math.ceil(left / DAY_MS));
      alerts.push({
        type: 'expiring',
        message: `The allowance expires in ${days} day${days === 1 ? '' : 's'} (${new Date(soonest).toISOString().slice(0, 10)}).`,
        command: 'polygon-agent wallet allowance renew'
      });
    }
  }

  const allowance = params.approved?.plan.allowanceUsd;
  if (allowance && allowance - params.spent < allowance * LOW_ALLOWANCE_SHARE) {
    alerts.push({
      type: 'allowance_low',
      message: `$${Math.max(0, allowance - params.spent).toFixed(2)} of the $${allowance} allowance is left.`,
      command: 'polygon-agent wallet allowance set --amount <usd>'
    });
  }

  const used = params.holdings.filter((h) => h.status === 'limit_used');
  if (used.length > 0) {
    alerts.push({
      type: 'limit_used',
      message: `The on-chain limit is used up for ${used.map((h) => `${h.symbol} on ${h.chain}`).join(', ')}.`,
      command: 'polygon-agent wallet allowance set'
    });
  }

  const uncovered = params.holdings.filter(
    (h) => h.status === 'not_covered' || h.status === 'native_not_spendable'
  );
  if (uncovered.length > 0) {
    alerts.push({
      type: 'uncovered_funds',
      message:
        `The wallet holds funds the agent can't spend: ${uncovered.map((h) => `${h.balance} ${h.symbol} on ${h.chain}`).join(', ')}. ` +
        'Tokens can be covered with a new code; native coins need the owner.',
      command: 'polygon-agent wallet allowance set --add <token@chain>'
    });
  }
  return alerts;
}

export function allowanceTotals(params: {
  wallet: string;
  approved: ApprovedPlan | null;
}): Record<string, unknown> | null {
  if (!params.approved) return null;
  const spent = spentUsdSince({ wallet: params.wallet, since: params.approved.approvedAt });
  const allowanceUsd = params.approved.plan.allowanceUsd;
  return {
    allowanceUsd,
    spentUsd: spent,
    remainingUsd: Math.max(0, Math.round((allowanceUsd - spent) * 100) / 100),
    approvedAt: params.approved.approvedAt,
    expiresAt: params.approved.plan.expiresAt
  };
}

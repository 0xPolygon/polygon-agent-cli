// The install's live smart sessions and their usage, read through the session
// key. plan.json is never trusted for spending; this is.

import type { Address } from 'viem';

import { getAddress } from 'viem';

import type { RemoteAccessClient } from '@polygonlabs/oms-wallet';

import { findNetworkById } from '@polygonlabs/oms-wallet';

import { CliError, httpStatus, mapOmsError } from '../errors.ts';
import { readRacRecord } from './rac.ts';

export interface LiveGrant {
  token: Address;
  limit: bigint;
  // null when OMS couldn't report usage.
  used: bigint | null;
  remaining: bigint | null;
}

export interface LiveSession {
  chainId: number;
  sessionId: string;
  walletId: string;
  expiresAt: string;
  expired: boolean;
  grants: LiveGrant[];
}

export type RacReader = Pick<RemoteAccessClient, 'listSessions' | 'getSessionUsage'>;

const CACHE_MS = 30_000;
const USAGE_ATTEMPTS = 5;
const USAGE_RETRY_MS = 3_000;

const cache = new Map<string, { at: number; sessions: LiveSession[] }>();

export function invalidateSessions(wallet: string): void {
  cache.delete(wallet);
}

// 401 from OMS means the session key no longer works: expired or revoked.
export function mapRacError(params: { error: unknown; wallet: string }): unknown {
  if (httpStatus(params.error) === 401) {
    const record = readRacRecord({ wallet: params.wallet, slot: 'rac' });
    if (record && Date.parse(record.expiresAt) <= Date.now()) {
      return new CliError({
        code: 'session_expired',
        message: "This install's access has expired.",
        command: 'polygon-agent wallet allowance renew',
        cause: params.error
      });
    }
    return new CliError({
      code: 'session_revoked',
      message: "This install's access was revoked.",
      hint: 'Connect again with a new email code.',
      command: 'polygon-agent wallet login --email <email>',
      cause: params.error
    });
  }
  return mapOmsError(params.error);
}

async function readUsage(params: {
  client: RacReader;
  sessionId: string;
  chainId: number;
  retryDelayMs: number;
}): Promise<Map<string, bigint | undefined> | null> {
  const network = findNetworkById(params.chainId);
  if (!network) return null;
  // A usage read right after approval has failed with a 500 before succeeding.
  for (let attempt = 1; ; attempt++) {
    try {
      const usage = await params.client.getSessionUsage({ sessionId: params.sessionId, network });
      const byToken = new Map<string, bigint | undefined>();
      for (const entry of usage) {
        if (entry.grant.kind === 'erc20Transfer') {
          byToken.set(entry.grant.token.toLowerCase(), entry.used);
        }
      }
      return byToken;
    } catch (error) {
      if (httpStatus(error) === 401) throw error;
      if (attempt >= USAGE_ATTEMPTS) return null;
      await new Promise((resolve) => setTimeout(resolve, params.retryDelayMs));
    }
  }
}

// Sessions (with usage) for this install. With chainId, only that chain's
// sessions are returned and only their usage is read. fresh bypasses the cache;
// spending always reads fresh.
export async function getSessions(params: {
  wallet: string;
  client: RacReader;
  fresh?: boolean;
  chainId?: number;
  retryDelayMs?: number;
}): Promise<LiveSession[]> {
  const cached = cache.get(params.wallet);
  const pick = (sessions: LiveSession[]) =>
    params.chainId === undefined ? sessions : sessions.filter((s) => s.chainId === params.chainId);
  if (!params.fresh && cached && Date.now() - cached.at < CACHE_MS) return pick(cached.sessions);

  try {
    const listed = await params.client.listSessions();
    const sessions: LiveSession[] = [];
    for (const session of listed) {
      if (params.chainId !== undefined && session.chainId !== params.chainId) continue;
      const usage = await readUsage({
        client: params.client,
        sessionId: session.sessionId,
        chainId: session.chainId,
        retryDelayMs: params.retryDelayMs ?? USAGE_RETRY_MS
      });
      const grants: LiveGrant[] = [];
      for (const grant of session.grants) {
        if (grant.kind !== 'erc20Transfer') continue;
        const used = usage ? (usage.get(grant.token.toLowerCase()) ?? 0n) : null;
        grants.push({
          token: getAddress(grant.token),
          limit: grant.limit,
          used,
          remaining: used === null ? null : grant.limit > used ? grant.limit - used : 0n
        });
      }
      sessions.push({
        chainId: session.chainId,
        sessionId: session.sessionId,
        walletId: session.walletId,
        expiresAt: session.expiresAt,
        expired: Date.parse(session.expiresAt) <= Date.now(),
        grants
      });
    }
    if (params.chainId === undefined) cache.set(params.wallet, { at: Date.now(), sessions });
    return sessions;
  } catch (error) {
    throw mapRacError({ error, wallet: params.wallet });
  }
}

// The live session that can spend `token` on a chain: one holding a grant for
// it, preferring the most remaining.
export function sessionForToken(params: {
  sessions: LiveSession[];
  chainId: number;
  token: string;
}): { session: LiveSession; grant: LiveGrant } | null {
  const token = params.token.toLowerCase();
  let best: { session: LiveSession; grant: LiveGrant } | null = null;
  for (const session of params.sessions) {
    if (session.chainId !== params.chainId || session.expired) continue;
    const grant = session.grants.find((g) => g.token.toLowerCase() === token);
    if (!grant) continue;
    const rank = (g: LiveGrant) => g.remaining ?? -1n;
    if (!best || rank(grant) > rank(best.grant)) best = { session, grant };
  }
  return best;
}

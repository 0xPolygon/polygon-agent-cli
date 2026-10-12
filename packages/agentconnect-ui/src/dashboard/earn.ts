// Live lending rates from Trails earn pools: the same source the CLI's
// `deposit` command picks from.

import { trailsApiKey } from '../config';

export interface EarnPool {
  id: string;
  name: string;
  protocol: string;
  apy: number;
  tvl: number;
  symbol: string;
}

interface RawPool {
  id: string;
  name: string;
  protocol: string;
  chainId: number;
  apy: number;
  tvl: number;
  isActive: boolean;
  token?: { symbol?: string };
}

export const STABLES = new Set(['USDC', 'USDT', 'USDT0', 'USDC.E', 'DAI']);

/** The largest active stablecoin pool per token on `chainId`, highest rate first. */
export async function fetchEarnPools(chainId = 137, limit = 3): Promise<EarnPool[]> {
  const res = await fetch('https://trails-api.sequence.app/rpc/Trails/GetEarnPools', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(trailsApiKey ? { 'X-Access-Key': trailsApiKey } : {})
    },
    body: JSON.stringify({ chainIds: [chainId] })
  });
  if (!res.ok) throw new Error(`GetEarnPools failed: ${res.status}`);
  const body = (await res.json()) as { pools?: RawPool[] };
  const byToken = new Map<string, RawPool>();
  for (const p of body.pools ?? []) {
    const symbol = p.token?.symbol?.toUpperCase() ?? '';
    if (!p.isActive || p.chainId !== chainId || !STABLES.has(symbol)) continue;
    const best = byToken.get(symbol);
    if (!best || p.tvl > best.tvl) byToken.set(symbol, p);
  }
  return [...byToken.values()]
    .sort((a, b) => b.apy - a.apy)
    .slice(0, limit)
    .map((p) => ({
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      apy: p.apy,
      tvl: p.tvl,
      symbol: p.token?.symbol ?? ''
    }));
}

// Every pool shown is a stablecoin lending market; size is the useful signal.
export function riskLabel(tvl: number): { label: string; badge: string } {
  return tvl >= 10_000_000
    ? { label: 'Low risk', badge: 'oms-badge--success' }
    : { label: 'Medium risk', badge: 'oms-badge--warning' };
}

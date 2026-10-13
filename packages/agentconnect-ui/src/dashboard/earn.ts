// Earn vaults: Morpho stablecoin vaults on Katana from the Trails Yield API,
// presented as three tiers. The tiers are assigned live by size: the largest
// open vault is Prime (the most established), then Frontier, then Advanced.

import { trailsApiKey } from '../config';

export const KATANA_CHAIN_ID = 747474;
const KATANA_RPC = 'https://rpc.katana.network';
const TRAILS = 'https://trails-api.sequence.app/rpc/Trails';

// A vault needs this much in it, and a real rate (not one that rounds to 0.00%),
// to be offered.
const MIN_TVL_USD = 10_000;
const MIN_APY = 0.1;
// Stablecoins the CLI can deposit on Katana. They carry a "vb" prefix there
// (vbUSDC); show the plain name.
const STABLES = new Set(['USDC', 'USDT']);

export type TierName = 'Prime' | 'Frontier' | 'Advanced';

export interface Tier {
  name: TierName;
  risk: string;
  badge: string;
  blurb: string;
}

export const TIERS: Tier[] = [
  {
    name: 'Prime',
    risk: 'Low risk',
    badge: 'oms-badge--success',
    blurb: 'The most established vault, with the most money in it. Steady rates.'
  },
  {
    name: 'Frontier',
    risk: 'Medium risk',
    badge: 'oms-badge--warning',
    blurb: 'A growing vault that takes on more to earn more. Rates move more.'
  },
  {
    name: 'Advanced',
    risk: 'Higher risk',
    badge: 'oms-badge--danger',
    blurb: 'A smaller, newer vault. Rates can swing, so use money you can leave alone.'
  }
];

export interface Vault {
  tier: Tier;
  marketId: string;
  // The vault contract, which is also its share token.
  address: string;
  apy: number;
  tvl: number;
  // The stablecoin it takes, as users know it (USDC, not vbUSDC).
  symbol: string;
  decimals: number;
}

interface RawMarket {
  id: string;
  inputTokens?: { symbol: string; decimals: number }[];
  outputToken?: { address?: string };
  rewardRate?: { total: number };
  statistics?: { tvlUsd?: string };
  status?: { enter: boolean };
  metadata?: { deprecated?: boolean; underMaintenance?: boolean };
}

const plainSymbol = (s: string) => s.replace(/^vb/i, '').toUpperCase();

/** The three tiers' vaults, largest first. Fewer than three when Katana has fewer that qualify. */
export function pickVaults(markets: RawMarket[]): Vault[] {
  return markets
    .map((m) => ({
      m,
      token: m.inputTokens?.[0],
      tvl: Number(m.statistics?.tvlUsd ?? 0),
      apy: (m.rewardRate?.total ?? 0) * 100
    }))
    .filter(
      ({ m, token, tvl, apy }) =>
        m.status?.enter &&
        !m.metadata?.deprecated &&
        !m.metadata?.underMaintenance &&
        m.outputToken?.address &&
        token &&
        STABLES.has(plainSymbol(token.symbol)) &&
        tvl >= MIN_TVL_USD &&
        apy >= MIN_APY
    )
    .sort((a, b) => b.tvl - a.tvl)
    .slice(0, TIERS.length)
    .map(({ m, token, tvl, apy }, i) => ({
      tier: TIERS[i],
      marketId: m.id,
      address: m.outputToken!.address!,
      apy,
      tvl,
      symbol: plainSymbol(token!.symbol),
      decimals: token!.decimals
    }));
}

export async function fetchVaults(): Promise<Vault[]> {
  const res = await fetch(`${TRAILS}/YieldGetMarkets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(trailsApiKey ? { 'X-Access-Key': trailsApiKey } : {})
    },
    body: JSON.stringify({ provider: 'morpho', chainId: String(KATANA_CHAIN_ID), limit: 100 })
  });
  if (!res.ok) throw new Error(`YieldGetMarkets failed: ${res.status}`);
  const body = (await res.json()) as { items?: RawMarket[] };
  return pickVaults(body.items ?? []);
}

const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

async function ethCall(calls: { to: string; data: string }[]): Promise<bigint[]> {
  const res = await fetch(KATANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      calls.map((c, id) => ({
        jsonrpc: '2.0',
        id,
        method: 'eth_call',
        params: [{ to: c.to, data: c.data }, 'latest']
      }))
    )
  });
  if (!res.ok) throw new Error(`Katana RPC failed: ${res.status}`);
  const out = (await res.json()) as { id: number; result?: string; error?: unknown }[];
  return calls.map((_, id) => {
    const r = out.find((o) => o.id === id);
    if (!r?.result) throw new Error('Katana RPC returned no result');
    return r.result === '0x' ? 0n : BigInt(r.result);
  });
}

/** What the wallet holds in each vault, in dollars (the vaults hold stablecoins), keyed by vault address. */
export async function fetchVaultBalances(
  wallet: string,
  vaults: Vault[]
): Promise<Record<string, number>> {
  if (vaults.length === 0) return {};
  // balanceOf(address) = 0x70a08231, convertToAssets(uint256) = 0x07a2d13a
  const shares = await ethCall(
    vaults.map((v) => ({ to: v.address, data: `0x70a08231${word(wallet)}` }))
  );
  const held = vaults.map((v, i) => ({ v, s: shares[i] })).filter(({ s }) => s > 0n);
  const assets = held.length
    ? await ethCall(
        held.map(({ v, s }) => ({ to: v.address, data: `0x07a2d13a${word(s.toString(16))}` }))
      )
    : [];
  const out: Record<string, number> = Object.fromEntries(vaults.map((v) => [v.address, 0]));
  held.forEach(({ v }, i) => {
    out[v.address] = Number(assets[i]) / 10 ** v.decimals;
  });
  return out;
}

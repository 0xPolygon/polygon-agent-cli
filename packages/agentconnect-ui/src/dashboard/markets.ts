// Polymarket positions for the dashboard's Markets tab. Positions belong to the
// Polymarket trading account, not the agent wallet, so the CLI passes that
// address as `?pm=`; without it the tab only offers prompts.

import { z } from 'zod/v4';

import { rpcCalls } from '../indexer';

const DATA_URL = 'https://data-api.polymarket.com';
// pUSD, Polymarket's collateral (6 decimals). Cash waiting in the trading
// account is held in it, as the CLI's `polymarket status` reports.
const PUSD = '0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb';

export interface Position {
  title: string;
  outcome: string;
  avgPrice: number;
  curPrice: number;
  value: number;
  cost: number;
  pnl: number;
  endDate: string | null;
  slug: string;
}

// A loose object naming only what is read below: a changed shape fails the
// parse, an added field doesn't.
const PositionsBody = z.looseObject({
  data: z
    .array(
      z.looseObject({
        title: z.string().optional(),
        outcome: z.string().optional(),
        avg_price: z.number().optional(),
        current_price: z.number().optional(),
        current_value: z.number().optional(),
        total_cost_usdc: z.number().optional(),
        unrealized_pnl: z.number().optional(),
        end_date: z.string().optional(),
        event_slug: z.string().optional()
      })
    )
    .optional()
});

export async function fetchPositions(address: string): Promise<Position[]> {
  const params = new URLSearchParams({ user: address, limit: '50', status: 'OPEN' });
  const res = await fetch(`${DATA_URL}/v2/positions?${params}`);
  if (!res.ok) throw new Error(`Polymarket positions failed: ${res.status}`);
  const body = PositionsBody.parse(await res.json());
  return (body.data ?? []).map((p) => ({
    title: p.title ?? 'Untitled market',
    outcome: p.outcome ?? '',
    avgPrice: p.avg_price ?? 0,
    curPrice: p.current_price ?? 0,
    value: p.current_value ?? 0,
    cost: p.total_cost_usdc ?? 0,
    pnl: p.unrealized_pnl ?? 0,
    endDate: p.end_date ?? null,
    slug: p.event_slug ?? ''
  }));
}

// Tenths of a cent, so a small move (17¢ to 16.5¢) doesn't round away.
export const cents = (price: number) => `${Math.round(price * 1000) / 10}¢`;

/** pUSD cash in the Polymarket trading account, not yet in a position. */
export async function fetchPredictionCash(address: string): Promise<number> {
  // balanceOf(address) = 0x70a08231
  const [raw] = await rpcCalls(137, [
    { to: PUSD, data: `0x70a08231${address.replace(/^0x/, '').toLowerCase().padStart(64, '0')}` }
  ]);
  if (!raw) throw new Error('pUSD balance read failed');
  return raw === '0x' ? 0 : Number(BigInt(raw)) / 1e6;
}

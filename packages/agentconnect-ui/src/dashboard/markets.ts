// Polymarket positions for the dashboard's Markets tab. Positions belong to the
// Polymarket trading account, not the agent wallet, so the CLI passes that
// address as `?pm=`; without it the tab only offers prompts.

const DATA_URL = 'https://data-api.polymarket.com';

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

interface RawPosition {
  title?: string;
  outcome?: string;
  avg_price?: number;
  current_price?: number;
  current_value?: number;
  total_cost_usdc?: number;
  unrealized_pnl?: number;
  end_date?: string;
  event_slug?: string;
  status?: string;
}

export async function fetchPositions(address: string): Promise<Position[]> {
  const params = new URLSearchParams({ user: address, limit: '50', status: 'OPEN' });
  const res = await fetch(`${DATA_URL}/v2/positions?${params}`);
  if (!res.ok) throw new Error(`Polymarket positions failed: ${res.status}`);
  const body = (await res.json()) as { data?: RawPosition[] };
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

export const cents = (price: number) => `${Math.round(price * 100)}¢`;

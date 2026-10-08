// Polymarket region rules. Blocked regions can't trade at all; close-only
// regions (the US among them) can sell, cancel, redeem and withdraw but not buy.

import { CliError } from '../errors.ts';
import { PolymarketError } from './gamma.ts';

export type Region = {
  blocked: boolean;
  closeOnly: boolean;
  country: string | null;
  region: string | null;
};

const GEOBLOCK_URL = process.env.POLYMARKET_GEOBLOCK_URL || 'https://polymarket.com/api/geoblock';

export async function checkRegion(client?: {
  fetchClosedOnlyMode(): Promise<boolean>;
}): Promise<Region> {
  let body: { blocked?: boolean; country?: string; region?: string };
  try {
    const res = await fetch(GEOBLOCK_URL);
    if (!res.ok) throw new Error(`geoblock ${res.status}`);
    body = (await res.json()) as typeof body;
  } catch (err) {
    throw new CliError({
      code: 'upstream_unavailable',
      message: `Couldn't check Polymarket's region rules: ${(err as Error).message}`,
      cause: err
    });
  }
  const closeOnly = client ? await client.fetchClosedOnlyMode() : false;
  return {
    blocked: body.blocked === true,
    closeOnly: closeOnly || body.blocked === true,
    country: body.country ?? null,
    region: body.region ?? null
  };
}

export function assertCanTrade(r: Region): void {
  if (r.blocked) {
    throw new PolymarketError(
      'region_blocked',
      `Polymarket isn't available from ${r.country ?? 'this region'}.`
    );
  }
}

export function assertCanOpen(r: Region): void {
  assertCanTrade(r);
  if (r.closeOnly) {
    throw new PolymarketError(
      'region_close_only',
      `Polymarket only allows closing positions from ${r.country ?? 'this region'}: sell, cancel, redeem and withdraw still work.`
    );
  }
}

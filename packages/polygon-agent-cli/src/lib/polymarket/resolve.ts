// Turn what an agent types (a conditionId, a market slug, or an event slug plus
// an outcome name) into the exact market side and CLOB asset id to trade.

import { CliError } from '../errors.ts';
import { PolymarketError } from './gamma.ts';
import { loadSdk, mapSdkError } from './sdk.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SdkMarket = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PublicClient = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SdkEvent = any;

export type ResolvedOutcome = {
  market: SdkMarket;
  outcome: 'yes' | 'no';
  label: string;
  assetId: string;
  price: string | null;
};

let pub: PublicClient | undefined;
export async function publicClient(): Promise<PublicClient> {
  if (!pub) pub = (await loadSdk()).root.createPublicClient();
  return pub;
}

const isConditionId = (ref: string) => /^0x[0-9a-fA-F]{64}$/.test(ref);

// Only a 404 means "not a market slug"; other rejections are real errors.
function isNotFound(
  err: unknown,
  root: { RequestRejectedError: new (...a: never[]) => Error }
): boolean {
  return err instanceof root.RequestRejectedError && (err as { status?: number }).status === 404;
}

async function byConditionId(ref: string): Promise<SdkMarket | null> {
  const c = await publicClient();
  for (const closed of [undefined, true]) {
    const page = await c
      .listMarkets({ conditionIds: [ref], ...(closed ? { closed } : {}) })
      .firstPage()
      .catch((e: unknown) => {
        throw mapSdkError(e);
      });
    if (page.items.length) return page.items[0];
  }
  return null;
}

export type SlugLookup = { market?: SdkMarket; event?: SdkEvent };

export async function lookupSlug(ref: string): Promise<SlugLookup> {
  const c = await publicClient();
  const { root } = await loadSdk();
  try {
    return { market: await c.fetchMarket({ slug: ref }) };
  } catch (err) {
    if (!isNotFound(err, root)) throw mapSdkError(err);
  }
  try {
    return { event: await c.fetchEvent({ slug: ref }) };
  } catch (err) {
    if (isNotFound(err, root)) return {};
    throw mapSdkError(err);
  }
}

function side(market: SdkMarket, outcome: 'yes' | 'no'): ResolvedOutcome {
  const o = market.outcomes?.[outcome];
  const assetId = market.version === 'v2' ? o?.positionId : o?.tokenId;
  if (!assetId) {
    throw new PolymarketError(
      'outcome_not_found',
      `Market ${market.slug ?? market.id} has no tradable ${outcome} side.`
    );
  }
  return { market, outcome, label: o.label, assetId, price: o.price ?? null };
}

function pickSide(market: SdkMarket, name: string): ResolvedOutcome {
  const n = name.trim().toLowerCase();
  for (const key of ['yes', 'no'] as const) {
    if (n === key || n === String(market.outcomes?.[key]?.label ?? '').toLowerCase())
      return side(market, key);
  }
  throw new CliError({
    code: 'outcome_not_found',
    message: `'${name}' isn't an outcome of this market.`,
    details: { choices: [market.outcomes?.yes?.label, market.outcomes?.no?.label].filter(Boolean) }
  });
}

function pickFromEvent(event: SdkEvent, name: string): ResolvedOutcome {
  let n = name.trim().toLowerCase();
  const titled = event.markets.filter((x: SdkMarket) => x.groupItemTitle);
  // A title that itself ends in yes/no ("Vote No") wins over reading the suffix as the side.
  const whole = titled.filter((x: SdkMarket) => String(x.groupItemTitle).toLowerCase() === n);
  if (whole.length === 1) return side(whole[0], 'yes');
  let outcome: 'yes' | 'no' = 'yes';
  const m = n.match(/^(.*)\s+(yes|no)$/);
  if (m) {
    n = m[1];
    outcome = m[2] as 'yes' | 'no';
  }
  const exact = titled.filter((x: SdkMarket) => String(x.groupItemTitle).toLowerCase() === n);
  const partial = exact.length
    ? exact
    : titled.filter((x: SdkMarket) => String(x.groupItemTitle).toLowerCase().includes(n));
  if (partial.length === 1) return side(partial[0], outcome);
  const choices = titled.map((x: SdkMarket) => x.groupItemTitle);
  if (partial.length > 1) {
    throw new CliError({
      code: 'ambiguous_market',
      message: `'${name}' matches several outcomes in ${event.slug}.`,
      details: { choices: partial.map((x: SdkMarket) => x.groupItemTitle) }
    });
  }
  throw new CliError({
    code: 'outcome_not_found',
    message: `'${name}' isn't an outcome of ${event.slug}.`,
    details: { choices }
  });
}

export async function resolveOutcome(ref: string, outcome: string): Promise<ResolvedOutcome> {
  if (isConditionId(ref)) {
    const market = await byConditionId(ref);
    if (!market)
      throw new PolymarketError('outcome_not_found', `No market with condition id ${ref}.`);
    return pickSide(market, outcome);
  }
  const found = await lookupSlug(ref);
  if (found.market) return pickSide(found.market, outcome);
  if (found.event) return pickFromEvent(found.event, outcome);
  throw new PolymarketError('outcome_not_found', `No market or event with slug '${ref}'.`);
}

export function summarizeMarket(m: SdkMarket): Record<string, unknown> {
  const out = (k: 'yes' | 'no') => {
    const o = m.outcomes?.[k] ?? {};
    return {
      label: o.label,
      price: o.price ?? null,
      assetId: m.version === 'v2' ? o.positionId : o.tokenId
    };
  };
  return {
    id: m.id,
    slug: m.slug,
    conditionId: m.conditionId,
    question: m.question,
    title: m.groupItemTitle ?? undefined,
    version: m.version,
    negRisk: !!m.state?.negRisk,
    acceptingOrders: !!m.state?.acceptingOrders,
    closed: !!m.state?.closed,
    endDate: m.state?.endDate ?? null,
    outcomes: { yes: out('yes'), no: out('no') },
    bestBid: m.prices?.bestBid ?? null,
    bestAsk: m.prices?.bestAsk ?? null,
    spread: m.prices?.spread ?? null,
    volume24hr: m.metrics?.volume24hr ?? null
  };
}

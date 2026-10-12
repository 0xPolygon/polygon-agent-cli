import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertCanOpen, assertCanTrade, checkRegion } from './region.ts';

function geo(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('checkRegion', () => {
  it('reports country and blocked from the geoblock endpoint', async () => {
    geo({ blocked: false, ip: 'x', country: 'PT', region: '11' });
    expect(await checkRegion()).toEqual({
      blocked: false,
      closeOnly: false,
      country: 'PT',
      region: '11'
    });
  });

  it('marks close-only when the CLOB says so', async () => {
    geo({ blocked: false, country: 'US', region: 'NY' });
    const r = await checkRegion({ fetchClosedOnlyMode: async () => true });
    expect(r.closeOnly).toBe(true);
  });

  it('treats an unreachable geoblock endpoint as upstream_unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(checkRegion()).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });
});

describe('asserts', () => {
  const base = { country: 'US', region: null };
  it('blocks opening in a close-only region but allows trading out', () => {
    const r = { ...base, blocked: false, closeOnly: true };
    expect(() => assertCanOpen(r)).toThrow(expect.objectContaining({ code: 'region_close_only' }));
    expect(() => assertCanTrade(r)).not.toThrow();
  });
  it('blocks everything in a blocked region', () => {
    const r = { ...base, blocked: true, closeOnly: true };
    expect(() => assertCanOpen(r)).toThrow(expect.objectContaining({ code: 'region_blocked' }));
    expect(() => assertCanTrade(r)).toThrow(expect.objectContaining({ code: 'region_blocked' }));
  });
});

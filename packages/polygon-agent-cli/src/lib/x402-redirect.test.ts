// x402 requests never follow redirects: a service can't bounce the request,
// with its payment and custom headers, to another host.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { noRedirectFetch } from './x402-guard.ts';

afterEach(() => vi.unstubAllGlobals());

describe('noRedirectFetch', () => {
  it('asks fetch not to follow redirects, and refuses one naming its target', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, { status: 307, headers: { location: 'http://169.254.169.254/' } })
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      noRedirectFetch('https://svc/data', { headers: { 'X-API-Key': 'k' } })
    ).rejects.toMatchObject({
      // Not a nothing-sent code: a paid request may be redirected after paying.
      code: 'upstream_error',
      message: expect.stringContaining('169.254.169.254')
    });
    expect(fetchMock).toHaveBeenCalledWith('https://svc/data', {
      headers: { 'X-API-Key': 'k' },
      redirect: 'manual'
    });
  });

  it('passes other answers through, 402 included', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('pay me', { status: 402 }))
    );
    expect((await noRedirectFetch('https://svc/data')).status).toBe(402);
  });
});

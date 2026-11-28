import { afterEach, describe, expect, it } from 'vitest';

import {
  checkAllowedHosts,
  loggable,
  proxyParts,
  resetVgsTokenCache,
  Vgs,
  VgsError
} from './vgs.ts';

const AUTH = 'https://auth.verygoodsecurity.com/auth/realms/vgs/protocol/openid-connect/token';
const PROXY_URL = 'https://RS123:s3cret@tnt.sandbox.agent-gateway.example:8443';

const CREATED = {
  data: {
    type: 'reveal-sessions',
    id: 'RS123',
    attributes: {
      state: 'active',
      expires_at: '2026-11-28T12:05:00Z',
      cards: [{ label: 'checkout', number: { value: '4111110000000013' }, cvc: { value: '731' } }],
      proxy: { url: PROXY_URL, ca_bundle: '-----BEGIN CERTIFICATE-----', pac_url: 'https://pac' }
    }
  }
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** VGS as the client uses it: answers in order, recording each request. */
function fakeVgs(answers: { status: number; body?: unknown }[]) {
  const calls: Call[] = [];
  let tokens = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call = {
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined
    };
    calls.push(call);
    if (url === AUTH) {
      tokens++;
      return Response.json({ access_token: `tok${tokens}`, expires_in: 1200 });
    }
    const next = answers.shift() ?? { status: 500 };
    return next.status === 204
      ? new Response(null, { status: 204 })
      : Response.json(next.body ?? {}, { status: next.status });
  }) as typeof fetch;
  const vgs = new Vgs({ clientId: 'sa-1', clientSecret: 'secret', vaultId: 'tntABC', fetchImpl });
  return { vgs, calls, api: () => calls.filter((c) => c.url !== AUTH) };
}

const CARD = {
  label: 'checkout',
  number: { alias: 'tok_sandbox_pan', bin: '411111', length: 16 },
  cvc: { alias: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', storage: 'VOLATILE' as const }
};

afterEach(() => resetVgsTokenCache());

describe('createRevealSession', () => {
  it('sends the cards and hosts to the tenant and returns the session aliases and proxy', async () => {
    const { vgs, calls, api } = fakeVgs([{ status: 201, body: CREATED }]);
    const s = await vgs.createRevealSession({
      cards: [CARD],
      allowedHosts: ['API.stripe.com', 'api.stripe.com'],
      context: { checkout_id: 'bco_1' }
    });

    expect(calls[0]!.body).toContain('grant_type=client_credentials');
    const [req] = api();
    expect(req!.url).toBe('https://sandbox.vgsapi.com/reveal-sessions');
    expect(req!.method).toBe('POST');
    expect(req!.headers).toMatchObject({
      Authorization: 'Bearer tok1',
      'VGS-Tenant': 'tntABC',
      'Content-Type': 'application/vnd.api+json'
    });
    expect(JSON.parse(req!.body!)).toEqual({
      data: {
        type: 'reveal-sessions',
        attributes: {
          allowed_hosts: ['api.stripe.com'],
          cards: [CARD],
          context: { checkout_id: 'bco_1' }
        }
      }
    });
    expect(s).toEqual({
      id: 'RS123',
      state: 'active',
      expiresAt: '2026-11-28T12:05:00Z',
      cards: [{ label: 'checkout', number: '4111110000000013', cvc: '731' }],
      proxy: { url: PROXY_URL, caBundle: '-----BEGIN CERTIFICATE-----', pacUrl: 'https://pac' }
    });
  });

  it('refuses hosts the API would refuse before calling it', async () => {
    const { vgs, api } = fakeVgs([]);
    for (const host of ['*.stripe.com', 'api.stripe.com:443', '10.0.0.1', 'localhost']) {
      await expect(
        vgs.createRevealSession({ cards: [CARD], allowedHosts: [host] })
      ).rejects.toMatchObject({
        code: 'invalid_host'
      });
    }
    const many = Array.from({ length: 21 }, (_, i) => `h${i}.example.com`);
    await expect(
      vgs.createRevealSession({ cards: [CARD], allowedHosts: many })
    ).rejects.toMatchObject({
      code: 'too_many_hosts'
    });
    expect(api()).toHaveLength(0);
  });

  it('needs a label on each card when there are several', async () => {
    const { vgs } = fakeVgs([]);
    const { label: _, ...unlabelled } = CARD;
    await expect(
      vgs.createRevealSession({ cards: [CARD, unlabelled], allowedHosts: ['api.stripe.com'] })
    ).rejects.toMatchObject({ code: 'invalid_card_label' });
  });

  it("reports VGS's error code without echoing the details", async () => {
    const { vgs } = fakeVgs([
      {
        status: 400,
        body: {
          errors: [
            {
              status: 400,
              code: 'never_host',
              title: 'Host not allowed',
              detail: 'tok_sandbox_pan'
            }
          ]
        }
      }
    ]);
    const err = await vgs
      .createRevealSession({ cards: [CARD], allowedHosts: ['api.stripe.com'] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VgsError);
    expect(err).toMatchObject({ status: 400, code: 'never_host' });
    expect((err as Error).message).not.toContain('tok_sandbox_pan');
  });

  it('treats a session without its proxy as a failure', async () => {
    const { vgs } = fakeVgs([
      { status: 201, body: { data: { id: 'RS1', attributes: { cards: [] } } } }
    ]);
    await expect(
      vgs.createRevealSession({ cards: [CARD], allowedHosts: ['api.stripe.com'] })
    ).rejects.toMatchObject({ code: 'unexpected_response' });
  });
});

describe('access tokens', () => {
  it('reuses a token, and signs in again once after a 401', async () => {
    const { vgs, calls } = fakeVgs([
      { status: 201, body: CREATED },
      { status: 401 },
      { status: 201, body: CREATED }
    ]);
    await vgs.createRevealSession({ cards: [CARD], allowedHosts: ['api.stripe.com'] });
    await vgs.createRevealSession({ cards: [CARD], allowedHosts: ['api.stripe.com'] });
    expect(calls.map((c) => (c.url === AUTH ? 'auth' : c.headers.Authorization))).toEqual([
      'auth',
      'Bearer tok1',
      'Bearer tok1',
      'auth',
      'Bearer tok2'
    ]);
  });

  it('fails clearly when the service account is refused', async () => {
    const fetchImpl = (async () =>
      Response.json({ error: 'unauthorized_client' }, { status: 401 })) as typeof fetch;
    const vgs = new Vgs({ clientId: 'bad', clientSecret: 'x', vaultId: 't', fetchImpl });
    await expect(vgs.proxyCa()).rejects.toMatchObject({ status: 401, code: 'unauthorized_client' });
  });
});

describe('reading and revoking', () => {
  it('reads a session without secrets, and null when VGS has none', async () => {
    const { vgs, api } = fakeVgs([
      {
        status: 200,
        body: {
          data: {
            id: 'RS123',
            attributes: {
              state: 'revoked',
              expires_at: '2026-11-28T12:05:00Z',
              allowed_hosts: ['api.stripe.com'],
              reveal_count: 1,
              refusal_count: 0
            }
          }
        }
      },
      { status: 404, body: { errors: [{ status: 404, title: 'Not found' }] } }
    ]);
    expect(await vgs.getRevealSession('RS123')).toEqual({
      id: 'RS123',
      state: 'revoked',
      expiresAt: '2026-11-28T12:05:00Z',
      allowedHosts: ['api.stripe.com'],
      revealCount: 1,
      refusalCount: 0
    });
    expect(await vgs.getRevealSession('RSgone')).toBeNull();
    expect(api()[0]!.url).toBe('https://sandbox.vgsapi.com/reveal-sessions/RS123');
  });

  it('revokes, and a session VGS no longer has counts as revoked', async () => {
    const { vgs, api } = fakeVgs([{ status: 204 }, { status: 404 }]);
    await vgs.revokeRevealSession('RS123');
    await vgs.revokeRevealSession('RS123');
    expect(api().map((c) => `${c.method} ${c.url}`)).toEqual([
      'DELETE https://sandbox.vgsapi.com/reveal-sessions/RS123',
      'DELETE https://sandbox.vgsapi.com/reveal-sessions/RS123'
    ]);
  });

  it('says so when the tenant has revocation switched off', async () => {
    const { vgs } = fakeVgs([
      { status: 409, body: { errors: [{ status: 409, code: 'revocation_list_disabled' }] } }
    ]);
    await expect(vgs.revokeRevealSession('RS123')).rejects.toMatchObject({
      code: 'revocation_list_disabled'
    });
  });

  it("reads the tenant's proxy CA", async () => {
    const { vgs, api } = fakeVgs([
      {
        status: 200,
        body: {
          data: {
            type: 'reveal-session-proxy-ca',
            attributes: { host: 'proxy.example', scheme: 'https', port: 8443, ca_bundle: 'PEM' }
          }
        }
      }
    ]);
    expect(await vgs.proxyCa()).toEqual({
      host: 'proxy.example',
      scheme: 'https',
      port: 8443,
      caBundle: 'PEM'
    });
    expect(api()[0]!.url).toBe('https://sandbox.vgsapi.com/reveal-sessions/proxy-ca');
  });

  it('uses the live API when asked', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return String(input) === AUTH
        ? Response.json({ access_token: 't' })
        : new Response(null, { status: 204 });
    }) as typeof fetch;
    await new Vgs({
      clientId: 'c',
      clientSecret: 's',
      vaultId: 'v',
      environment: 'live',
      fetchImpl
    }).revokeRevealSession('RS1');
    expect(calls[1]).toBe('https://vgsapi.com/reveal-sessions/RS1');
  });
});

describe('helpers', () => {
  it("splits a session's proxy URL into what a browser host needs", () => {
    expect(proxyParts(PROXY_URL)).toEqual({
      scheme: 'https',
      host: 'tnt.sandbox.agent-gateway.example',
      port: 8443,
      username: 'RS123',
      password: 's3cret'
    });
  });

  it('logs a session without its secrets', async () => {
    const { vgs } = fakeVgs([{ status: 201, body: CREATED }]);
    const s = await vgs.createRevealSession({ cards: [CARD], allowedHosts: ['api.stripe.com'] });
    const line = JSON.stringify(loggable(s));
    expect(line).not.toContain('s3cret');
    expect(line).not.toContain('4111110000000013');
    expect(line).toContain('RS123');
  });

  it('normalises allowed hosts', () => {
    expect(checkAllowedHosts([' Checkout.Example.com ', 'checkout.example.com'])).toEqual([
      'checkout.example.com'
    ]);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from './index.ts';
import type { McpProps } from './mcp.ts';

import { handleMcp } from './mcp.ts';
import { CredentialStore } from './store.ts';

const WALLET = '0x00000000000000000000000000000000000000aa';

function fakeKv() {
  const data = new Map<string, string>();
  return {
    get: async (k: string) => data.get(k) ?? null,
    put: async (k: string, v: string) => void data.set(k, v)
  } as unknown as KVNamespace;
}

const env = (): Env => ({
  ASSETS: {} as Fetcher,
  CREDENTIALS: fakeKv(),
  CREDENTIALS_KEY: 'test-credentials-key'
});

const OWNER: McpProps = { wallet: WALLET, email: 'owner@example.com' };

const rpc = async (e: Env, body: unknown, props: McpProps = OWNER) => {
  const res = await handleMcp(
    new Request('https://agentconnect.test/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }),
    e,
    props
  );
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
};

const call = async (
  e: Env,
  name: string,
  args: Record<string, unknown> = {},
  props: McpProps = OWNER
) =>
  (
    (
      await rpc(
        e,
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
        props
      )
    ).body as {
      result: { content: { text: string }[]; isError?: boolean; structuredContent?: unknown };
    }
  ).result;

describe('MCP server', () => {
  it('initializes with the requested protocol version', async () => {
    const { body } = await rpc(env(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' }
    });
    expect(body).toMatchObject({
      id: 1,
      result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } }
    });
  });

  it('acknowledges notifications with no body', async () => {
    const { status } = await rpc(env(), { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(status).toBe(202);
  });

  it('lists the wallet tools', async () => {
    const { body } = await rpc(env(), { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = (body as { result: { tools: { name: string }[] } }).result.tools.map(
      (t) => t.name
    );
    expect(names).toEqual([
      'get_wallet',
      'get_shipping_address',
      'save_shipping_address',
      'list_cards',
      'add_card',
      'check_card',
      'buy',
      'authorize_checkout',
      'payment_status'
    ]);
  });

  it('answers get_wallet for the signed-in wallet only', async () => {
    const r = await call(env(), 'get_wallet');
    expect(r.structuredContent).toMatchObject({
      address: WALLET,
      owner: 'owner@example.com',
      dashboardUrl: `https://agentconnect.test/?wallet=${WALLET}&chain=137&view=dashboard`
    });
  });

  it('saves and reads the shipping address, sealed', async () => {
    const e = env();
    const saved = await call(e, 'save_shipping_address', {
      name: 'Alex Rivera',
      line1: '214 Bergen St',
      city: 'Brooklyn',
      state: 'NY',
      zip: '11217',
      country: 'US'
    });
    expect(saved.isError).toBeUndefined();
    expect(
      (await new CredentialStore(e.CREDENTIALS!, 'test-credentials-key').get(WALLET)).address
    ).toMatchObject({ line1: '214 Bergen St' });
    expect((await call(e, 'get_shipping_address')).structuredContent).toMatchObject({
      address: { city: 'Brooklyn' }
    });
  });

  it('reports bad input as a tool error, not a protocol error', async () => {
    const r = await call(env(), 'buy', { conversation_id: 'c' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/ask is required/);
  });

  it('says when cards are not configured', async () => {
    const r = await call(env(), 'list_cards');
    expect(r).toMatchObject({ isError: true });
    expect(r.content[0].text).toMatch(/Cards are not configured/);
  });

  it('rejects an unknown tool', async () => {
    const { body } = await rpc(env(), {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'send_tokens' }
    });
    expect(body).toMatchObject({ error: { code: -32602 } });
  });
});

const MUSE: McpProps = { ...OWNER, profile: 'muse' };

const toolNames = async (props: McpProps) =>
  (
    (await rpc(env(), { jsonrpc: '2.0', id: 2, method: 'tools/list' }, props)).body as {
      result: { tools: { name: string }[] };
    }
  ).result.tools.map((t) => t.name);

// A card service that prices a $6.75 cart, and places it when confirmed.
function cardService() {
  const buys: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const u = new URL(String(input));
    if (u.pathname !== '/buy') return Response.json({}, { status: 404 });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    buys.push(body);
    const cart = {
      merchant: 'retail',
      merchant_name: 'Amazon',
      items: [{ name: 'AA batteries, 24-pack', qty: 1, priceCents: 1499 }],
      totalCents: 1742,
      hash: 'cart_hash_1'
    };
    return Response.json(
      body.confirm
        ? { conversation_id: 'conv_1', status: 'order_placed', order_id: 'ord_1', cart }
        : { conversation_id: 'conv_1', status: 'needs_input', reply: 'Found it.', cart }
    );
  });
  return buys;
}

// A wallet with a saved address and a card ready to pay.
async function cardEnv(limitCents = 2500) {
  const e: Env = { ...env(), AGENTCARD_CLIENT_ID: 'client', AGENTCARD_CLIENT_SECRET: 'secret' };
  await new CredentialStore(e.CREDENTIALS!, 'test-credentials-key').update(WALLET, (r) => ({
    ...r,
    autoPayLimitCents: limitCents,
    address: {
      name: 'Alex Rivera',
      line1: '214 Bergen St',
      city: 'Brooklyn',
      state: 'NY',
      zip: '11217',
      country: 'US'
    },
    agentcardConnection: {
      userId: 'usr_1',
      accessToken: 'act_1',
      refreshToken: 'rct_1',
      expiresAt: Date.now() + 3_600_000
    }
  }));
  return e;
}

describe('MCP client profiles', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('shows a Muse connection only the tools Muse allows', async () => {
    expect(await toolNames(MUSE)).toEqual([
      'get_wallet',
      'get_shipping_address',
      'save_shipping_address',
      'list_cards',
      'add_card',
      'check_card',
      'buy',
      'payment_status',
      'confirm_purchase'
    ]);
    expect(await toolNames(OWNER)).not.toContain('confirm_purchase');
  });

  it('refuses a hidden tool called by name', async () => {
    const { body } = await rpc(
      env(),
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'authorize_checkout' } },
      MUSE
    );
    expect(body).toMatchObject({ error: { code: -32602 } });
  });

  it('tells a Muse connection to confirm each purchase', async () => {
    const { body } = await rpc(env(), { jsonrpc: '2.0', id: 1, method: 'initialize' }, MUSE);
    expect((body as { result: { instructions: string } }).result.instructions).toMatch(
      /confirm_purchase/
    );
  });

  it('pays at once under the limit for a standard connection', async () => {
    const buys = cardService();
    const r = await call(await cardEnv(), 'buy', { ask: 'AA batteries' });
    expect(r.structuredContent).toMatchObject({ autoPay: true, orderId: 'ord_1' });
    expect(buys).toHaveLength(2);
  });

  it('quotes for Muse and charges nothing', async () => {
    const buys = cardService();
    const r = await call(await cardEnv(), 'buy', { ask: 'AA batteries' }, MUSE);
    expect(r.structuredContent).toMatchObject({
      status: 'quote',
      merchant: 'Amazon',
      totalCents: 1742,
      currency: 'USD',
      shipTo: 'Alex Rivera, Brooklyn, NY',
      needsOwnerApproval: false
    });
    expect(buys).toHaveLength(1);
    expect(buys[0].confirm).toBeUndefined();
  });

  it('pays a quote once, for the approved total only', async () => {
    const buys = cardService();
    const e = await cardEnv();
    const quote = (await call(e, 'buy', { ask: 'AA batteries' }, MUSE)).structuredContent as {
      quoteId: string;
    };

    const wrong = await call(
      e,
      'confirm_purchase',
      { quote_id: quote.quoteId, total_cents: 1500 },
      MUSE
    );
    expect(wrong.isError).toBe(true);
    expect(wrong.content[0].text).toMatch(/does not match this quote/);
    expect(buys).toHaveLength(1);

    const paid = await call(
      e,
      'confirm_purchase',
      { quote_id: quote.quoteId, total_cents: 1742 },
      MUSE
    );
    expect(paid.structuredContent).toMatchObject({ autoPay: true, orderId: 'ord_1' });
    expect(buys[1]).toMatchObject({ conversation_id: 'conv_1', confirm: 'cart_hash_1' });

    const again = await call(
      e,
      'confirm_purchase',
      { quote_id: quote.quoteId, total_cents: 1742 },
      MUSE
    );
    expect(again.structuredContent).toMatchObject({ alreadyConfirmed: true, orderId: 'ord_1' });
    expect(buys).toHaveLength(2);
  });

  it('still sends a quote over the auto-pay limit to the owner', async () => {
    const buys = cardService();
    const e = await cardEnv(1000);
    const quote = (await call(e, 'buy', { ask: 'AA batteries' }, MUSE)).structuredContent as {
      quoteId: string;
      needsOwnerApproval: boolean;
    };
    expect(quote.needsOwnerApproval).toBe(true);
    const r = await call(
      e,
      'confirm_purchase',
      { quote_id: quote.quoteId, total_cents: 1742 },
      MUSE
    );
    expect(r.structuredContent).toMatchObject({ status: 'pending_approval', limitCents: 1000 });
    expect(buys).toHaveLength(1);
  });

  it('refuses an expired quote', async () => {
    cardService();
    const e = await cardEnv();
    const quote = (await call(e, 'buy', { ask: 'AA batteries' }, MUSE)).structuredContent as {
      quoteId: string;
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    const r = await call(
      e,
      'confirm_purchase',
      { quote_id: quote.quoteId, total_cents: 1742 },
      MUSE
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/expired/);
  });
});

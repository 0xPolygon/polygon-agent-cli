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

const OPENAI: McpProps = { ...OWNER, profile: 'openai' };

const call = async (
  e: Env,
  name: string,
  props: McpProps = OWNER,
  args: Record<string, unknown> = {}
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

// The shopping tools, with arguments before the connection.
const shop = (e: Env, name: string, args: Record<string, unknown> = {}, props: McpProps = OWNER) =>
  call(e, name, props, args);

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

  it('lists only get_wallet and shopping for a connection made without an allowance', async () => {
    const { body } = await rpc(env(), { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(
      (body as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)
    ).toEqual([
      'get_wallet',
      'get_shipping_address',
      'save_shipping_address',
      'list_cards',
      'add_card',
      'check_card',
      'buy',
      'authorize_checkout',
      'get_checkout_card',
      'close_checkout',
      'start_browser_checkout',
      'browser_look',
      'browser_click',
      'browser_type',
      'browser_select',
      'browser_press',
      'browser_scroll',
      'browser_open',
      'pay_browser_checkout',
      'browser_checkout_status',
      'cancel_browser_checkout',
      'payment_status'
    ]);
  });

  it('lists every tool for a standard connection with an allowance', async () => {
    const { body } = await rpc(
      env(),
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { ...OWNER, keyId: 'k1' }
    );
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
      'get_checkout_card',
      'close_checkout',
      'start_browser_checkout',
      'browser_look',
      'browser_click',
      'browser_type',
      'browser_select',
      'browser_press',
      'browser_scroll',
      'browser_open',
      'pay_browser_checkout',
      'browser_checkout_status',
      'cancel_browser_checkout',
      'payment_status',
      'get_allowance',
      'send',
      'swap_quote',
      'swap',
      'swap_status',
      'pay_service',
      'earn_vaults',
      'earn_deposit',
      'earn_withdraw',
      'polymarket_markets',
      'polymarket_account',
      'polymarket_deposit',
      'polymarket_buy',
      'polymarket_sell',
      'polymarket_cancel',
      'polymarket_redeem',
      'polymarket_withdraw',
      'get_action'
    ]);
  });

  it('marks the tools that move money as destructive', async () => {
    const { body } = await rpc(
      env(),
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { ...OWNER, keyId: 'k1' }
    );
    const tools = (body as { result: { tools: { name: string; annotations: unknown }[] } }).result
      .tools;
    for (const name of ['send', 'swap']) {
      expect(tools.find((t) => t.name === name)?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true
      });
    }
  });

  it("marks every ChatGPT tool as reading only the owner's own wallet", async () => {
    const { body } = await rpc(env(), { jsonrpc: '2.0', id: 2, method: 'tools/list' }, OPENAI);
    for (const t of (body as { result: { tools: Record<string, unknown>[] } }).result.tools) {
      expect(t.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      });
      expect(t.outputSchema).toBeTypeOf('object');
    }
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
    const saved = await shop(e, 'save_shipping_address', {
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
    expect((await shop(e, 'get_shipping_address')).structuredContent).toMatchObject({
      address: { city: 'Brooklyn' }
    });
  });

  it('reports bad input as a tool error, not a protocol error', async () => {
    const r = await shop(env(), 'buy', { conversation_id: 'c' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/ask is required/);
  });

  it('says when cards are not configured', async () => {
    const r = await shop(env(), 'list_cards');
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
      line2: '',
      city: 'Brooklyn',
      state: 'NY',
      zip: '11217',
      country: 'US',
      phone: ''
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
    const r = await shop(await cardEnv(), 'buy', { ask: 'AA batteries' });
    expect(r.structuredContent).toMatchObject({ autoPay: true, orderId: 'ord_1' });
    expect(buys).toHaveLength(2);
  });

  it('quotes for Muse and charges nothing', async () => {
    const buys = cardService();
    const r = await shop(await cardEnv(), 'buy', { ask: 'AA batteries' }, MUSE);
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
    const quote = (await shop(e, 'buy', { ask: 'AA batteries' }, MUSE)).structuredContent as {
      quoteId: string;
    };

    const wrong = await shop(
      e,
      'confirm_purchase',
      { quote_id: quote.quoteId, total_cents: 1500 },
      MUSE
    );
    expect(wrong.isError).toBe(true);
    expect(wrong.content[0].text).toMatch(/does not match this quote/);
    expect(buys).toHaveLength(1);

    const paid = await shop(
      e,
      'confirm_purchase',
      { quote_id: quote.quoteId, total_cents: 1742 },
      MUSE
    );
    expect(paid.structuredContent).toMatchObject({ autoPay: true, orderId: 'ord_1' });
    expect(buys[1]).toMatchObject({ conversation_id: 'conv_1', confirm: 'cart_hash_1' });

    const again = await shop(
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
    const quote = (await shop(e, 'buy', { ask: 'AA batteries' }, MUSE)).structuredContent as {
      quoteId: string;
      needsOwnerApproval: boolean;
    };
    expect(quote.needsOwnerApproval).toBe(true);
    const r = await shop(
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
    const quote = (await shop(e, 'buy', { ask: 'AA batteries' }, MUSE)).structuredContent as {
      quoteId: string;
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    const r = await shop(
      e,
      'confirm_purchase',
      { quote_id: quote.quoteId, total_cents: 1742 },
      MUSE
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/expired/);
  });

  it('lets a Muse connection with an allowance move money', async () => {
    const { body } = await rpc(
      env(),
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { ...MUSE, keyId: 'k1' }
    );
    const names = (body as { result: { tools: { name: string }[] } }).result.tools.map(
      (t) => t.name
    );
    expect(names).toContain('send');
    expect(names).not.toContain('propose_bundle');
  });
});

describe('MCP money tools', () => {
  // A stand-in for the connection's Durable Object: records what it was asked.
  const keys = (answer: unknown) => {
    const asked: { name: string; body: unknown }[] = [];
    const ns = {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: async (_url: string, init: { body: string }) => {
          asked.push({ name, body: JSON.parse(init.body) });
          return Response.json(answer);
        }
      })
    } as unknown as DurableObjectNamespace;
    return { ns, asked };
  };

  it("won't let a connection made without an allowance call a money tool", async () => {
    const { body } = await rpc(env(), {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'send', arguments: { token: 'USDC', amount: '1', to: WALLET } }
    });
    expect(body).toMatchObject({ error: { code: -32602 } });
  });

  it("sends through the connection's own key, for its wallet", async () => {
    const { ns, asked } = keys({ ok: true, value: { txHash: '0xabc' } });
    const r = await call(
      { ...env(), AGENT_KEYS: ns },
      'send',
      { ...OWNER, keyId: 'k1' },
      {
        token: 'USDC',
        amount: '5',
        to: '0x000000000000000000000000000000000000dEaD',
        chain: 'base'
      }
    );
    expect(r.structuredContent).toEqual({ txHash: '0xabc' });
    expect(asked).toEqual([
      {
        name: 'k1',
        body: {
          op: 'send',
          wallet: WALLET,
          token: 'USDC',
          amount: '5',
          to: '0x000000000000000000000000000000000000dEaD',
          chain: 'base'
        }
      }
    ]);
  });

  it("returns the key's refusal as a tool error the agent can read", async () => {
    const { ns } = keys({
      ok: false,
      error: { error: 'Over the allowance.', code: 'allowance_exhausted' }
    });
    const r = await call(
      { ...env(), AGENT_KEYS: ns },
      'swap',
      { ...OWNER, keyId: 'k1' },
      {
        intent_id: 'i1'
      }
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text)).toEqual({
      error: 'Over the allowance.',
      code: 'allowance_exhausted'
    });
  });

  it("saves a ChatGPT spend for the owner to approve, and doesn't spend", async () => {
    const { ns, asked } = keys({
      ok: true,
      value: { actionId: 'a1', title: 'Send 5 USDC', expiresAt: 'later' }
    });
    const r = await call(
      { ...env(), AGENT_KEYS: ns },
      'send',
      { ...OPENAI, keyId: 'k1', appName: 'ChatGPT' },
      { token: 'USDC', amount: '5', to: WALLET }
    );
    expect(r.structuredContent).toMatchObject({
      status: 'pending_approval',
      actionId: 'a1',
      approvalUrl: 'https://agentconnect.test/approve?k=k1&a=a1'
    });
    expect(asked).toEqual([
      {
        name: 'k1',
        body: {
          op: 'propose',
          wallet: WALLET,
          appName: 'ChatGPT',
          request: { op: 'send', token: 'USDC', amount: '5', to: WALLET }
        }
      }
    ]);
  });

  it('saves several ChatGPT spends for one approval', async () => {
    const { ns, asked } = keys({
      ok: true,
      value: { actionId: 'a2', title: 'Two steps', expiresAt: 'later' }
    });
    const r = await call(
      { ...env(), AGENT_KEYS: ns },
      'propose_bundle',
      { ...OPENAI, keyId: 'k1', appName: 'ChatGPT' },
      {
        steps: [
          { tool: 'polymarket_deposit', arguments: { usd: '10' } },
          { tool: 'polymarket_buy', arguments: { market: 'fed', outcome: 'Yes', usd: '5' } }
        ]
      }
    );
    expect(r.structuredContent).toMatchObject({ status: 'pending_approval', actionId: 'a2' });
    expect(asked[0].body).toMatchObject({
      op: 'propose_bundle',
      steps: [
        { op: 'pm_deposit', usd: '10' },
        { op: 'pm_buy', market: 'fed', outcome: 'Yes', usd: '5' }
      ]
    });
  });

  it("won't put a tool that doesn't spend in a bundle", async () => {
    const { ns, asked } = keys({ ok: true, value: {} });
    const r = await call(
      { ...env(), AGENT_KEYS: ns },
      'propose_bundle',
      { ...OPENAI, keyId: 'k1' },
      {
        steps: [
          { tool: 'get_action', arguments: {} },
          { tool: 'send', arguments: {} }
        ]
      }
    );
    expect(r.isError).toBe(true);
    expect(asked).toHaveLength(0);
  });

  it('lets ChatGPT read and quote without approval', async () => {
    const { ns, asked } = keys({ ok: true, value: { allowanceUsd: 10 } });
    await call({ ...env(), AGENT_KEYS: ns }, 'get_allowance', { ...OPENAI, keyId: 'k1' });
    expect(asked[0].body).toMatchObject({ op: 'status' });
  });

  it('tells each client what it can do', async () => {
    const instructions = async (props: McpProps) =>
      (
        (await rpc(env(), { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, props))
          .body as { result: { instructions: string } }
      ).result.instructions;
    expect(await instructions({ ...OWNER, keyId: 'k1' })).toMatch(/send, swap and bridge/);
    expect(await instructions(OWNER)).toMatch(/can't move funds/);
    expect(await instructions({ ...OPENAI, keyId: 'k1' })).toMatch(/approves every spend/);
    expect(await instructions(OPENAI)).toMatch(/can't move funds/);
  });
});

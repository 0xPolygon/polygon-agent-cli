import { describe, expect, it } from 'vitest';

import type { Env } from './index.ts';

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

const rpc = async (e: Env, body: unknown) => {
  const res = await handleMcp(
    new Request('https://agentconnect.test/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }),
    e,
    { wallet: WALLET, email: 'owner@example.com' }
  );
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
};

const call = async (e: Env, name: string, args: Record<string, unknown> = {}) =>
  (
    (
      await rpc(e, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args }
      })
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

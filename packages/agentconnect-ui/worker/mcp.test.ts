import { describe, expect, it } from 'vitest';

import type { Env } from './index.ts';
import type { McpProps } from './mcp.ts';

import { handleMcp } from './mcp.ts';

const WALLET = '0x00000000000000000000000000000000000000aa';

const env = (): Env => ({ ASSETS: {} as Fetcher });

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

  it('lists only get_wallet for a connection made without an allowance', async () => {
    const { body } = await rpc(env(), { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(
      (body as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)
    ).toEqual(['get_wallet']);
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
      'get_allowance',
      'send',
      'swap_quote',
      'swap',
      'swap_status',
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

describe('MCP client profiles', () => {
  it('shows a Muse connection only the tools Muse allows', async () => {
    const { body } = await rpc(env(), { jsonrpc: '2.0', id: 2, method: 'tools/list' }, MUSE);
    expect(
      (body as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)
    ).toEqual(['get_wallet']);
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

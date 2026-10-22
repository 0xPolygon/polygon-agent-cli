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

const call = async (e: Env, name: string, props: McpProps = OWNER) =>
  (
    (await rpc(e, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } }, props))
      .body as {
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
    expect(names).toEqual(['get_wallet']);
  });

  it("marks every tool as reading only the owner's own wallet", async () => {
    const { body } = await rpc(env(), { jsonrpc: '2.0', id: 2, method: 'tools/list' });
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

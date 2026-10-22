// The agent wallet over MCP (Streamable HTTP, stateless JSON responses), for
// agents that can't run the CLI. The OAuth provider in front of it has already
// checked the bearer token; `props` names the wallet the owner signed in with.
//
// It covers what needs no wallet signature: the wallet and its balances.
// Moving tokens stays with the CLI, which holds the keys.
//
// What a connection sees depends on its profile (profiles.ts): which tools.

import type { Env } from './index.ts';
import type { Profile, ProfilePolicy } from './profiles.ts';

import { policyOf } from './profiles.ts';

export interface McpProps {
  wallet: string;
  email: string | null;
  // Set when the owner allowed the connection; absent on older connections.
  profile?: Profile;
}

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER = { name: 'open-money-agent', title: 'Open Money Agent', version: '1.1.0' };

const INSTRUCTIONS = `Open Money Agent: the owner's agent wallet on Polygon and what it holds, with a link to their dashboard. This connection only reads the wallet; it can't move funds.`;

const TOOLS = [
  {
    name: 'get_wallet',
    title: 'Wallet',
    description:
      "The wallet's address, what it holds in US dollars, and the owner's dashboard link.",
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'The wallet address on Polygon.' },
        owner: { type: ['string', 'null'], description: 'The email the owner signed in with.' },
        network: { type: 'string' },
        totalUsd: { type: 'number', description: 'What the wallet holds, in US dollars.' },
        holdings: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, usd: { type: 'number' } },
            required: ['name', 'usd']
          }
        },
        dashboardUrl: { type: 'string', description: "The owner's dashboard for this wallet." }
      },
      required: ['address', 'network', 'dashboardUrl']
    },
    // Only reads the owner's own wallet: it changes nothing and reaches no one else.
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: [{ type: 'oauth2', scopes: ['wallet'] }],
    // Names the signed-in account, so ChatGPT can tell connected accounts apart.
    _meta: { 'openai/profile': true }
  }
];

/** The tools a connection's profile allows. */
function toolsFor(policy: ProfilePolicy) {
  return TOOLS.filter((t) => policy.tools.includes(t.name));
}

type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: unknown };

const rpcResult = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: Rpc['id'], code: number, message: string) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message }
});

const toolText = (value: unknown, isError = false) => ({
  content: [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
  ],
  ...(isError ? { isError: true } : {}),
  ...(!isError && typeof value === 'object' && value ? { structuredContent: value } : {})
});

async function walletHoldings(env: Env, wallet: string) {
  if (!env.INDEXER_ACCESS_KEY) return null;
  const res = await fetch('https://polygon-indexer.sequence.app/rpc/Indexer/GetTokenBalances', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Access-Key': env.INDEXER_ACCESS_KEY },
    body: JSON.stringify({ accountAddress: wallet, includeMetadata: true })
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    balances?: { balanceUSD?: string; contractInfo?: { name?: string; symbol?: string } }[];
  };
  const rows = (body.balances ?? [])
    .map((b) => ({
      name: b.contractInfo?.name ?? b.contractInfo?.symbol ?? 'Token',
      usd: Math.round(Number(b.balanceUSD ?? 0) * 100) / 100
    }))
    .filter((r) => r.usd > 0)
    .sort((a, b) => b.usd - a.usd);
  return { totalUsd: Math.round(rows.reduce((t, r) => t + r.usd, 0) * 100) / 100, holdings: rows };
}

async function callTool(env: Env, props: McpProps, name: string, origin: string) {
  switch (name) {
    case 'get_wallet':
      return {
        address: props.wallet,
        owner: props.email,
        network: 'Polygon',
        ...((await walletHoldings(env, props.wallet)) ?? {}),
        dashboardUrl: `${origin}/?wallet=${props.wallet}&chain=137&view=dashboard`
      };
    default:
      return undefined;
  }
}

async function handleMessage(env: Env, props: McpProps, msg: Rpc, origin: string) {
  const policy = policyOf(props.profile);
  switch (msg.method) {
    case 'initialize': {
      const asked = (msg.params as { protocolVersion?: string } | undefined)?.protocolVersion;
      return rpcResult(msg.id, {
        protocolVersion: asked && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions: INSTRUCTIONS
      });
    }
    case 'ping':
      return rpcResult(msg.id, {});
    case 'tools/list':
      return rpcResult(msg.id, { tools: toolsFor(policy) });
    case 'tools/call': {
      const p = (msg.params ?? {}) as { name?: string };
      // Checked here too, not only in the list: a hidden tool can't be called by name.
      if (!p.name || !policy.tools.includes(p.name)) {
        return rpcError(msg.id, -32602, `Unknown tool: ${p.name}`);
      }
      try {
        return rpcResult(msg.id, toolText(await callTool(env, props, p.name, origin)));
      } catch (err) {
        console.error('[mcp]', err);
        return rpcResult(msg.id, toolText('Something went wrong. Try again.', true));
      }
    }
    default:
      return msg.id === undefined || msg.id === null
        ? null // a notification (initialized, cancelled): nothing to answer
        : rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

/** POST /mcp: one JSON-RPC message or a batch. GET has no stream to offer. */
export async function handleMcp(req: Request, env: Env, props: McpProps): Promise<Response> {
  if (req.method === 'GET' || req.method === 'DELETE') {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  }
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(rpcError(null, -32700, 'Parse error'), { status: 400 });
  }
  const origin = new URL(req.url).origin;
  const messages = (Array.isArray(body) ? body : [body]) as Rpc[];
  const replies = (
    await Promise.all(messages.map((m) => handleMessage(env, props, m, origin)))
  ).filter(Boolean);
  if (replies.length === 0) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? replies : replies[0]);
}

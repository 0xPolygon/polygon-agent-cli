// The agent wallet over MCP (Streamable HTTP, stateless JSON responses), for
// agents that can't run the CLI. The OAuth provider in front of it has already
// checked the bearer token; `props` names the wallet the owner signed in with.
//
// It covers what needs no wallet signature: balances and the saved address.
// Moving tokens stays with the CLI, which holds the keys.
//
// What a connection sees depends on its profile (profiles.ts): which tools.

import type { Env } from './index.ts';
import type { Profile, ProfilePolicy } from './profiles.ts';

import { policyOf } from './profiles.ts';
import { store } from './services.ts';
import { parseAddress, ValidationError } from './shipping.ts';

export interface McpProps {
  wallet: string;
  email: string | null;
  // Set when the owner allowed the connection; absent on older connections.
  profile?: Profile;
}

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER = { name: 'polygon-agent-wallet', title: 'Polygon agent wallet', version: '1.0.0' };

const INSTRUCTIONS = `The owner's Polygon agent wallet: what it holds and their saved shipping address. Never repeat the shipping address unless the owner asks for it. Sending, swapping, or predicting with the wallet's funds needs the Polygon agent CLI (npx skills add https://github.com/0xPolygon/polygon-agent-cli).`;

const ADDRESS_PROPS = {
  name: { type: 'string', description: 'Recipient full name' },
  line1: { type: 'string', description: 'Street address' },
  line2: { type: 'string', description: 'Apartment or suite (optional)' },
  city: { type: 'string' },
  state: { type: 'string', description: 'State or region, e.g. CA' },
  zip: { type: 'string', description: 'ZIP or postal code' },
  country: { type: 'string', description: 'Country code, e.g. US' },
  phone: { type: 'string', description: 'Phone for delivery' }
};

const TOOLS = [
  {
    name: 'get_wallet',
    title: 'Wallet',
    description:
      "The wallet's address, what it holds in US dollars, and the owner's dashboard link.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'get_shipping_address',
    title: 'Shipping address',
    description: "The owner's saved shipping address, or null.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'save_shipping_address',
    title: 'Save shipping address',
    description: 'Save or replace the shipping address. Only with the owner saying so.',
    inputSchema: {
      type: 'object',
      properties: ADDRESS_PROPS,
      required: ['name', 'line1', 'city', 'state', 'zip', 'country']
    },
    annotations: { readOnlyHint: false, idempotentHint: true }
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

async function callTool(
  env: Env,
  props: McpProps,
  name: string,
  args: Record<string, unknown>,
  origin: string
) {
  const db = store(env);
  const need = () => {
    if (!db) throw new ValidationError('Saved details are not configured on this server.');
    return db;
  };
  switch (name) {
    case 'get_wallet':
      return {
        address: props.wallet,
        owner: props.email,
        network: 'Polygon',
        ...((await walletHoldings(env, props.wallet)) ?? {}),
        dashboardUrl: `${origin}/?wallet=${props.wallet}&chain=137&view=dashboard`
      };
    case 'get_shipping_address':
      return { address: (await need().get(props.wallet)).address ?? null };
    case 'save_shipping_address': {
      const address = parseAddress(args);
      await need().update(props.wallet, (r) => ({ ...r, address }));
      return { address };
    }
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
      const p = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      // Checked here too, not only in the list: a hidden tool can't be called by name.
      if (!p.name || !policy.tools.includes(p.name)) {
        return rpcError(msg.id, -32602, `Unknown tool: ${p.name}`);
      }
      try {
        return rpcResult(
          msg.id,
          toolText(await callTool(env, props, p.name, p.arguments ?? {}, origin))
        );
      } catch (err) {
        if (err instanceof ValidationError) return rpcResult(msg.id, toolText(err.message, true));
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

// The agent wallet over MCP (Streamable HTTP, stateless JSON responses), for
// agents that can't run the CLI. The OAuth provider in front of it has already
// checked the bearer token; `props` names the wallet the owner signed in with.
//
// It covers what needs no wallet signature: balances, the saved address and
// cards, and buying with the saved card (each purchase approved with the
// owner's passkey). Moving tokens stays with the CLI, which holds the keys.

import type { Env } from './index.ts';

import { AgentCardError } from './agentcard.ts';
import {
  agentCard,
  buyTurn,
  listWalletCards,
  pollCardSession,
  startCardSession,
  store
} from './services.ts';
import { parseAddress, ValidationError } from './shipping.ts';

export interface McpProps {
  wallet: string;
  email: string | null;
}

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER = { name: 'polygon-agent-wallet', title: 'Polygon agent wallet', version: '1.0.0' };

const INSTRUCTIONS = `The owner's Polygon agent wallet: what it holds, their saved shipping address and cards, and buying at real stores with the saved card.

To buy something: call buy with what they want. Show the cart (items and total) and ask before confirming. Confirm with the cart's hash. The confirm pauses with an approval_url: send it to the owner on its own line; they approve with their passkey, then call the same confirm again. Nothing is charged before they approve.

Never repeat the shipping address outside a purchase. Sending, swapping, or predicting with the wallet's funds needs the Polygon agent CLI (npx skills add https://github.com/0xPolygon/polygon-agent-cli).`;

const ADDRESS_PROPS = {
  name: { type: 'string', description: 'Recipient full name' },
  line1: { type: 'string', description: 'Street address' },
  line2: { type: 'string', description: 'Apartment or suite (optional)' },
  city: { type: 'string' },
  state: { type: 'string', description: 'State or region, e.g. CA' },
  zip: { type: 'string', description: 'ZIP or postal code' },
  country: { type: 'string', description: 'Country code, e.g. US' },
  phone: { type: 'string', description: 'Phone for delivery (retail orders need one)' }
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
    description: "The owner's saved shipping address, or null. Use it when buying for them.",
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
  },
  {
    name: 'list_cards',
    title: 'Saved cards',
    description: 'Saved cards: brand, last four digits, and expiry. Never the number.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'add_card',
    title: 'Add a card',
    description:
      "A one-time link where the owner saves a card behind their passkey. Send `url` exactly as given, alone on its own line. Then call check_card with the session id once they're done.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false }
  },
  {
    name: 'check_card',
    title: 'Check a new card',
    description: 'Whether the owner finished saving the card from add_card.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id']
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'buy',
    title: 'Buy with the saved card',
    description:
      "Shop at real stores (Amazon, Walmart, Target, Best Buy, DoorDash, and more) with the saved card and address. Send `ask` with what they want, or their answer, plus conversation_id to continue. When a cart is shown, confirm its exact hash only after the owner agrees. A confirm pauses with approval_url for the owner's passkey; call the same confirm again after they approve. With no card saved yet it answers requires_action with nextAction.url: send that link to the owner, then call check_card. Each turn can take up to two minutes.",
    inputSchema: {
      type: 'object',
      properties: {
        ask: { type: 'string', description: 'What to buy, or the answer to a question' },
        conversation_id: { type: 'string', description: 'The purchase conversation to continue' },
        confirm: { type: 'string', description: 'The cart hash to place (16 hex characters)' }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }
];

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
  const cards = agentCard(env);
  const need = () => {
    if (!db) throw new ValidationError('Saved details are not configured on this server.');
    return db;
  };
  const needCards = () => {
    if (!cards) throw new ValidationError('Cards are not configured on this server.');
    return cards;
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
    case 'list_cards':
      return { cards: await listWalletCards(need(), needCards(), props.wallet) };
    case 'add_card': {
      const s = await startCardSession(need(), needCards(), props.wallet);
      return { url: s.url, session_id: s.sessionId, expires_at: s.expiresAt };
    }
    case 'check_card': {
      const id = typeof args.session_id === 'string' ? args.session_id : '';
      const s = await pollCardSession(need(), needCards(), props.wallet, id);
      if (!s) throw new ValidationError('No such add-a-card session for this wallet.');
      return s;
    }
    case 'buy': {
      const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : undefined);
      const confirm = str('confirm');
      if (confirm && !/^[0-9a-f]{16}$/.test(confirm)) {
        throw new ValidationError('confirm must be the cart hash from the last turn.');
      }
      if (!str('ask') && !confirm)
        throw new ValidationError('Send ask, or confirm with conversation_id.');
      if (confirm && !str('conversation_id'))
        throw new ValidationError('confirm needs conversation_id.');
      return buyTurn(need(), needCards(), props.wallet, {
        ask: str('ask'),
        conversationId: str('conversation_id'),
        confirm
      });
    }
    default:
      return undefined;
  }
}

async function handleMessage(env: Env, props: McpProps, msg: Rpc, origin: string) {
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
      return rpcResult(msg.id, { tools: TOOLS });
    case 'tools/call': {
      const p = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      if (!TOOLS.some((t) => t.name === p.name)) {
        return rpcError(msg.id, -32602, `Unknown tool: ${p.name}`);
      }
      try {
        return rpcResult(
          msg.id,
          toolText(await callTool(env, props, p.name!, p.arguments ?? {}, origin))
        );
      } catch (err) {
        if (err instanceof ValidationError) return rpcResult(msg.id, toolText(err.message, true));
        if (err instanceof AgentCardError) {
          console.error('[mcp agentcard]', err.status, err.code, err.message);
          return rpcResult(
            msg.id,
            toolText('The card service is unavailable. Try again shortly.', true)
          );
        }
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

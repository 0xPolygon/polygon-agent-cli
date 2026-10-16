// The agent wallet over MCP (Streamable HTTP, stateless JSON responses), for
// agents that can't run the CLI. The OAuth provider in front of it has already
// checked the bearer token; `props` names the wallet the owner signed in with.
//
// It covers what needs no wallet signature: balances, the saved address and
// cards, and buying with the saved card (each purchase approved with the
// owner's passkey). Moving tokens stays with the CLI, which holds the keys.
//
// What a connection sees depends on its profile (profiles.ts): which tools,
// and whether buy pays at once or returns a quote for confirm_purchase.

import type { Env } from './index.ts';
import type { Profile, ProfilePolicy } from './profiles.ts';

import { AgentCardError, agentCardFailure } from './agentcard.ts';
import { policyOf } from './profiles.ts';
import {
  agentCard,
  approvalStatus,
  authorizeCheckout,
  buyTurn,
  confirmQuote,
  parseCheckout,
  listWalletCards,
  pollCardSession,
  startCardSession,
  store
} from './services.ts';
import { parseAddress, ValidationError } from './shipping.ts';

export interface McpProps {
  wallet: string;
  email: string | null;
  // Set when the owner allowed the connection; absent on older connections.
  profile?: Profile;
}

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER = { name: 'polygon-agent-wallet', title: 'Polygon agent wallet', version: '1.0.0' };

const STANDARD_INSTRUCTIONS = `The owner's Polygon agent wallet: what it holds, their saved shipping address, and paying with the card they saved securely. Never ask the owner for a card number.

When something needs paying for, the owner has set an auto-pay limit. At or under it you pay without asking. Over it, you get an approval_url: send it to the owner on its own line, then call payment_status with the approval_id. It waits for their decision, so keep calling it until the status settles, and tell them the outcome.

Buying from a store that takes orders directly (Amazon, Walmart, Target, Best Buy, DoorDash, and more): call buy with what they want. It ships to the saved address and pays with the saved card, or comes back for approval. Answer its questions with another buy call on the same conversation_id.

Paying at any other store's checkout in your browser (Kernel or Browserbase with card checkout support): call authorize_checkout with the store and the checkout total first. Once it says approved, fill shipping from get_shipping_address, enter a placeholder card (4242 4242 4242 4242, any future expiry, any CVC), and submit; the saved card pays. Confirm the order on the store's page before reporting it, and never retry a payment on your own.

No card saved yet: buy answers with the add-card link (or call add_card). Never repeat the shipping address outside a purchase. Sending, swapping, or predicting with the wallet's funds needs the Polygon agent CLI (npx skills add https://github.com/0xPolygon/polygon-agent-cli).`;

// For clients that confirm each purchase with the user: nothing is charged
// until the user approves the quoted total.
const CONFIRM_INSTRUCTIONS = `The owner's Polygon agent wallet: what it holds, their saved shipping address, and paying with the card they saved securely. Never ask the owner for a card number.

Buying from a store that takes orders directly (Amazon, Walmart, Target, Best Buy, DoorDash, and more): call buy with what they want. It answers questions on the same conversation_id, then returns a quote: the store, items, fees, total in USD, where it ships, and when the quote expires. Nothing is charged yet. Show the user the full quote and ask them to approve that exact total. Once they do, call confirm_purchase with the quote_id and the total_cents shown. If the price changed or the quote expired, get a new quote and ask again.

If the total is over the owner's auto-pay limit, confirm_purchase returns an approval_url: send it to the owner on its own line, then call payment_status with the approval_id until the status settles. Report an order only once its status says it was placed, with the order id. Never confirm a quote twice.

No card saved yet: buy answers with the add-card link (or call add_card). Never repeat the shipping address outside a purchase.`;

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
    title: 'Buy',
    description:
      "Buy something at a store that takes orders directly (Amazon, Walmart, Target, Best Buy, DoorDash, and more), shipped to the saved address and paid with the saved card. Under the owner's auto-pay limit it is ordered right away; over it the answer is pending_approval with approval_url and approval_id (send the link, then call payment_status). Answer questions with another call on the same conversation_id. A turn can take up to two minutes.",
    inputSchema: {
      type: 'object',
      properties: {
        ask: { type: 'string', description: 'What to buy, or the answer to a question' },
        conversation_id: { type: 'string', description: 'The purchase conversation to continue' }
      },
      required: ['ask']
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  },
  {
    name: 'authorize_checkout',
    title: 'Authorize a checkout',
    description:
      "Before paying at a store's checkout in your own browser: the store and the total. Under the owner's auto-pay limit it answers approved at once; over it, pending_approval with approval_url and approval_id. Pay only once approved.",
    inputSchema: {
      type: 'object',
      properties: {
        merchant: { type: 'string', description: 'The store, e.g. IKEA' },
        merchant_url: { type: 'string', description: 'The checkout or product page' },
        total_cents: {
          type: 'integer',
          description: 'The checkout total in cents, including tax and shipping'
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              qty: { type: 'integer' },
              price_cents: { type: 'integer' }
            },
            required: ['name']
          }
        }
      },
      required: ['merchant', 'total_cents']
    },
    annotations: { readOnlyHint: false, destructiveHint: false }
  },
  {
    name: 'payment_status',
    title: 'Payment status',
    description:
      'Where an approval is: pending, approved, declined, placed (the order went through), or failed. Waits up to 25 seconds for the owner, so call it again while it says pending.',
    inputSchema: {
      type: 'object',
      properties: { approval_id: { type: 'string' } },
      required: ['approval_id']
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'confirm_purchase',
    title: 'Confirm a purchase',
    description:
      "Pay for a quote from buy, once the user approved its total. Pass the quote_id and the total_cents they approved; a different total is refused. Under the owner's auto-pay limit the order is placed with the saved card; over it the answer is pending_approval with approval_url and approval_id. A quote pays at most once.",
    inputSchema: {
      type: 'object',
      properties: {
        quote_id: { type: 'string', description: 'The quote_id from buy' },
        total_cents: {
          type: 'integer',
          description: 'The total the user approved, in cents, exactly as quoted'
        }
      },
      required: ['quote_id', 'total_cents']
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }
];

// buy for clients that confirm each purchase: it only ever returns a quote.
const QUOTE_BUY = {
  description:
    'Find something at a store that takes orders directly (Amazon, Walmart, Target, Best Buy, DoorDash, and more) and price it, shipped to the saved address: returns a quote with the items, fees, total in USD and a quote_id. Nothing is charged; pay with confirm_purchase once the user approves the total. Answer questions with another call on the same conversation_id. A turn can take up to two minutes.',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
};

/** The tools a connection's profile allows, as it sees them. */
function toolsFor(policy: ProfilePolicy) {
  return TOOLS.filter((t) => policy.tools.includes(t.name)).map((t) =>
    t.name === 'buy' && policy.confirmEachPurchase ? { ...t, ...QUOTE_BUY } : t
  );
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
      const ask = typeof args.ask === 'string' ? args.ask.trim() : '';
      if (!ask)
        throw new ValidationError('ask is required: what to buy, or the answer to a question.');
      const conversationId =
        typeof args.conversation_id === 'string' ? args.conversation_id : undefined;
      return buyTurn(need(), needCards(), props.wallet, { ask, conversationId }, origin, {
        confirmEachPurchase: policyOf(props.profile).confirmEachPurchase
      });
    }
    case 'confirm_purchase': {
      const quoteId = typeof args.quote_id === 'string' ? args.quote_id : '';
      if (!quoteId) throw new ValidationError('quote_id is required: the quote_id from buy.');
      if (!Number.isInteger(args.total_cents)) {
        throw new ValidationError(
          'total_cents is required: the total the user approved, in cents.'
        );
      }
      return confirmQuote(
        need(),
        needCards(),
        props.wallet,
        { quoteId, totalCents: args.total_cents as number },
        origin
      );
    }
    case 'authorize_checkout':
      return authorizeCheckout(
        need(),
        props.wallet,
        parseCheckout({
          merchant: args.merchant,
          merchantUrl: args.merchant_url,
          totalCents: args.total_cents,
          items: Array.isArray(args.items)
            ? (args.items as Record<string, unknown>[]).map((i) => ({
                name: i.name,
                qty: i.qty,
                priceCents: i.price_cents
              }))
            : []
        }),
        origin
      );
    case 'payment_status': {
      const id = typeof args.approval_id === 'string' ? args.approval_id : '';
      const s = await approvalStatus(need(), needCards(), props.wallet, id, origin, 25_000);
      if (!s) throw new ValidationError('No such approval for this wallet.');
      return s;
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
        instructions: policy.confirmEachPurchase ? CONFIRM_INSTRUCTIONS : STANDARD_INSTRUCTIONS
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
        if (err instanceof AgentCardError) {
          console.error('[mcp agentcard]', err.status, err.code, err.message);
          return rpcResult(msg.id, toolText(agentCardFailure(err).message, true));
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

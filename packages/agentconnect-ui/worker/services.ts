// What the HTTP API and the MCP server both do for a wallet: saved cards,
// add-a-card sessions, and purchases through AgentCard.

import type { BuyTurn } from './agentcard.ts';
import type { Env } from './index.ts';
import type { Approval, WalletRecord } from './store.ts';

import { AgentCard, AgentCardError } from './agentcard.ts';
import { ValidationError } from './shipping.ts';
import { CredentialStore } from './store.ts';

export function store(env: Env): CredentialStore | null {
  if (!env.CREDENTIALS || !env.CREDENTIALS_KEY) return null;
  return new CredentialStore(env.CREDENTIALS, env.CREDENTIALS_KEY);
}

export function agentCard(env: Env): AgentCard | null {
  if (!env.AGENTCARD_CLIENT_ID || !env.AGENTCARD_CLIENT_SECRET) return null;
  return new AgentCard({
    clientId: env.AGENTCARD_CLIENT_ID,
    clientSecret: env.AGENTCARD_CLIENT_SECRET,
    autoApproval: env.AGENTCARD_AUTO_APPROVAL === 'on'
  });
}

export const cardView = (c: {
  id: string;
  brand: string;
  last4: string;
  expiry_month: number;
  expiry_year: number;
}) => ({
  id: c.id,
  brand: c.brand,
  last4: c.last4,
  expMonth: c.expiry_month,
  expYear: c.expiry_year
});

/**
 * Keep the user's connection from a linked add-a-card session. Single use, so
 * a failure (an account that needs a code, an already exchanged session) is
 * logged and the card still counts as saved.
 */
export async function connectFromSession(
  db: CredentialStore,
  cards: AgentCard,
  wallet: string,
  sessionId: string
): Promise<void> {
  try {
    const c = await cards.exchangeVaultSession(sessionId);
    if (!c.user?.id) return;
    await db.update(wallet, (r) => ({
      ...r,
      agentcardConnection: {
        userId: c.user!.id,
        accessToken: c.access_token,
        refreshToken: c.refresh_token,
        expiresAt: Date.now() + (c.expires_in ?? 3600) * 1000
      }
    }));
  } catch (err) {
    console.error('[agentcard] exchange', err instanceof Error ? err.message : err);
  }
}

/** A live token acting as the wallet's card user, refreshed when close to expiry. */
export async function userToken(
  db: CredentialStore,
  cards: AgentCard,
  wallet: string
): Promise<string | null> {
  const conn = (await db.get(wallet)).agentcardConnection;
  if (!conn) return null;
  if (conn.expiresAt - 60_000 > Date.now()) return conn.accessToken;
  const next = await cards.refreshConnection(conn.refreshToken);
  await db.update(wallet, (r) => ({
    ...r,
    agentcardConnection: {
      userId: conn.userId,
      accessToken: next.access_token,
      refreshToken: next.refresh_token,
      expiresAt: Date.now() + (next.expires_in ?? 3600) * 1000
    }
  }));
  return next.access_token;
}

// The card service is a provider detail: keep its name out of what agents relay.
const neutral = (text: string) =>
  text
    .replace(/\byour agent ?card account\b/gi, 'your saved card')
    .replace(/\bagent ?card\b/gi, 'the card service');

// What agents see of a purchase turn: enough to show the cart and act on it.
const turnView = (t: BuyTurn) => ({
  conversationId: t.conversation_id,
  status: t.status,
  reply: t.reply ? neutral(t.reply) : null,
  cart: t.cart ?? null,
  unmatched: t.unmatched ?? [],
  products: (t.catalog?.items ?? []).slice(0, 8).map((i) => ({
    name: i.name,
    priceCents: i.priceCents ?? null,
    url: i.id,
    imageUrl: i.image_url ?? null
  })),
  declineCode: t.decline_code ?? null,
  approvalUrl: t.approval_url ?? null,
  chargeStatus: t.charge_status ?? null,
  orderId: t.order_id ?? null,
  paidWith: t.payment_source?.last4
    ? `${t.payment_source.brand ?? 'card'} ending ${t.payment_source.last4}`
    : null
});

const addCardTurn = (session: { url?: string; sessionId: string }) => ({
  status: 'requires_action' as const,
  nextAction: {
    type: 'add_card',
    message:
      'Save a card first: open this link, add a debit or credit card, and protect it with your passkey. Then ask again.',
    url: session.url ?? null,
    sessionId: session.sessionId
  }
});

// Purchases at or under this pay without asking unless the owner sets another limit.
export const DEFAULT_AUTO_PAY_CENTS = 2500;
const MAX_APPROVALS = 50;

const limitOf = (r: { autoPayLimitCents?: number }) =>
  r.autoPayLimitCents ?? DEFAULT_AUTO_PAY_CENTS;
const randomId = (prefix: string) =>
  `${prefix}_${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')}`;

function deliveryAddress(
  address: NonNullable<Awaited<ReturnType<CredentialStore['get']>>['address']>
) {
  return {
    street: address.line1,
    ...(address.line2 ? { address2: address.line2 } : {}),
    city: address.city,
    state: address.state,
    zip: address.zip,
    country: address.country,
    name: address.name,
    ...(address.phone ? { phone: address.phone } : {})
  };
}

const approvalUrl = (origin: string, id: string) => `${origin}/approve?r=${id}`;

async function createApproval(
  db: CredentialStore,
  wallet: string,
  a: Omit<Approval, 'id' | 'status' | 'createdAt'>
): Promise<Approval> {
  const approval: Approval = {
    ...a,
    id: randomId('apr'),
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  await db.update(wallet, (r) => ({
    ...r,
    approvals: [...(r.approvals ?? []), approval].slice(-MAX_APPROVALS)
  }));
  await db.linkApproval(approval.id, wallet);
  return approval;
}

/**
 * Confirm a cart with the saved card and wait for the outcome. A confirm can
 * answer with progress ("loading checkout") while it keeps running; then the
 * conversation's own status says how it ended.
 */
async function confirmCart(
  cards: AgentCard,
  token: string,
  body: Parameters<AgentCard['buy']>[1],
  waitMs = 90_000
): Promise<BuyTurn> {
  const turn = await cards.buy(token, { ...body, payment_source: 'vault' });
  const settled =
    turn.status === 'order_placed' || turn.status === 'partially_placed' || !!turn.decline_code;
  if (settled || !body.conversation_id) return turn;
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 4000));
    const conv = await cards.buyConversation(token, body.conversation_id).catch(() => null);
    if (!conv || conv.turn_in_progress) continue;
    const order = conv.orders?.[0];
    if (order) return { ...turn, status: 'order_placed', order_id: order.order_id };
    const last = conv.last_checkout;
    if (last?.decline_code || last?.status === 'placed') {
      return {
        ...turn,
        status: last.status === 'placed' ? 'order_placed' : 'declined',
        decline_code: last.decline_code ?? null,
        approval_url: last.approval_url ?? null,
        charge_status: last.charge_status ?? null,
        order_id: last.order_id ?? null
      };
    }
  }
  return turn;
}

/**
 * Buy something for the owner. AgentCard finds it and builds a cart shipped to
 * the saved address; a cart at or under the owner's auto-pay limit is placed
 * right away with the saved card, and one over it waits for the owner on the
 * approval page. Questions come back as `needs_input` to answer with `ask`.
 */
export async function buyTurn(
  db: CredentialStore,
  cards: AgentCard,
  wallet: string,
  input: { ask: string; conversationId?: string },
  origin: string
) {
  const token = await userToken(db, cards, wallet);
  // No card in the vault for purchases yet: answer with the link that adds one.
  if (!token) return addCardTurn(await startCardSession(db, cards, wallet));
  const record = await db.get(wallet);
  const delivery = record.address ? { delivery_address: deliveryAddress(record.address) } : {};
  const turn = await cards.buy(token, {
    ask: input.ask,
    ...(input.conversationId ? { conversation_id: input.conversationId } : {}),
    ...delivery
  });
  const cart = turn.cart;
  if (!cart?.hash || turn.status !== 'needs_input' || turn.decline_code) return turnView(turn);

  if (cart.totalCents <= limitOf(record)) {
    const placed = await confirmCart(cards, token, {
      conversation_id: turn.conversation_id,
      confirm: cart.hash,
      ...delivery
    });
    return { ...turnView(placed), autoPay: true };
  }
  const approval = await createApproval(db, wallet, {
    kind: 'cart',
    merchant: cart.merchant_name ?? cart.merchant,
    merchantUrl: null,
    totalCents: cart.totalCents,
    items: cart.items.map((i) => ({ name: i.name, qty: i.qty, priceCents: i.priceCents })),
    conversationId: turn.conversation_id,
    hash: cart.hash
  });
  return {
    ...turnView(turn),
    status: 'pending_approval',
    approvalId: approval.id,
    approvalUrl: approvalUrl(origin, approval.id),
    limitCents: limitOf(record)
  };
}

/**
 * Before paying at a store's checkout in the agent's own browser: at or under
 * the limit it may go ahead; over it, the owner approves first.
 */
export async function authorizeCheckout(
  db: CredentialStore,
  wallet: string,
  input: {
    merchant: string;
    merchantUrl: string | null;
    totalCents: number;
    items: Approval['items'];
  },
  origin: string
) {
  const limit = limitOf(await db.get(wallet));
  if (input.totalCents <= limit)
    return { status: 'approved', autoApproved: true, limitCents: limit };
  const approval = await createApproval(db, wallet, {
    kind: 'checkout',
    ...input,
    conversationId: null,
    hash: null
  });
  return {
    status: 'pending_approval',
    approvalId: approval.id,
    approvalUrl: approvalUrl(origin, approval.id),
    limitCents: limit
  };
}

const approvalView = (a: Approval, origin: string) => ({
  approvalId: a.id,
  kind: a.kind,
  status: a.status,
  merchant: a.merchant,
  totalCents: a.totalCents,
  items: a.items,
  ...(a.status === 'pending' ? { approvalUrl: approvalUrl(origin, a.id) } : {}),
  ...(a.result ? { result: a.result } : {})
});

/** Where an approval is. Waits up to `waitMs` for the owner to decide (or the order to land). */
export async function approvalStatus(
  db: CredentialStore,
  cards: AgentCard,
  wallet: string,
  id: string,
  origin: string,
  waitMs = 0
) {
  const until = Date.now() + waitMs;
  for (;;) {
    const a = ((await db.get(wallet)).approvals ?? []).find((x) => x.id === id);
    if (!a) return null;
    // Approved here, then waiting on AgentCard's passkey step: the order lands on its own.
    if (a.status === 'awaiting_passkey' && a.conversationId) {
      const token = await userToken(db, cards, wallet);
      const conv = token
        ? await cards.buyConversation(token, a.conversationId).catch(() => null)
        : null;
      const order = conv?.orders?.[0];
      if (order) {
        const result = { orderId: order.order_id, merchant: order.merchant ?? a.merchant };
        await setApproval(db, wallet, id, { status: 'placed', result });
        return approvalView({ ...a, status: 'placed', result }, origin);
      }
    }
    const settled = a.status !== 'pending' && a.status !== 'awaiting_passkey';
    if (settled || Date.now() >= until) return approvalView(a, origin);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function setApproval(
  db: CredentialStore,
  wallet: string,
  id: string,
  change: Partial<Approval>
) {
  await db.update(wallet, (r) => ({
    ...r,
    approvals: (r.approvals ?? []).map((x) => (x.id === id ? { ...x, ...change } : x))
  }));
}

/** The approval page's view, by approval id alone (the page has no agent token). */
export async function approvalForPage(db: CredentialStore, id: string) {
  const wallet = await db.approvalWallet(id);
  if (!wallet) return null;
  const a = ((await db.get(wallet)).approvals ?? []).find((x) => x.id === id);
  return a ? { wallet, approval: a } : null;
}

/**
 * The owner, signed in on the approval page, decides. Approving a cart places
 * it with the saved card; AgentCard may still ask for their passkey, and then
 * `passkeyUrl` is where to send them.
 */
export async function decideApproval(
  db: CredentialStore,
  cards: AgentCard,
  id: string,
  signedInWallet: string,
  approve: boolean
): Promise<{ status: Approval['status']; passkeyUrl?: string | null }> {
  const found = await approvalForPage(db, id);
  if (!found || found.wallet.toLowerCase() !== signedInWallet.toLowerCase()) {
    throw new ValidationError(
      'This approval belongs to another account. Sign in with the account your agent uses.'
    );
  }
  const { wallet, approval: a } = found;
  if (a.status !== 'pending') return { status: a.status };
  const decidedAt = new Date().toISOString();
  if (!approve) {
    await setApproval(db, wallet, id, { status: 'declined', decidedAt });
    return { status: 'declined' };
  }
  if (a.kind === 'checkout') {
    await setApproval(db, wallet, id, { status: 'approved', decidedAt });
    return { status: 'approved' };
  }
  const token = await userToken(db, cards, wallet);
  if (!token || !a.conversationId || !a.hash) {
    await setApproval(db, wallet, id, {
      status: 'failed',
      decidedAt,
      result: { reason: 'no_card' }
    });
    return { status: 'failed' };
  }
  const record = await db.get(wallet);
  const turn = await confirmCart(cards, token, {
    conversation_id: a.conversationId,
    confirm: a.hash,
    ...(record.address ? { delivery_address: deliveryAddress(record.address) } : {})
  });
  const view = turnView(turn);
  if (turn.status === 'order_placed' || turn.status === 'partially_placed') {
    await setApproval(db, wallet, id, { status: 'placed', decidedAt, result: view });
    return { status: 'placed' };
  }
  if (turn.decline_code === 'vault_approval_required' && turn.approval_url) {
    await setApproval(db, wallet, id, { status: 'awaiting_passkey', decidedAt, result: view });
    return { status: 'awaiting_passkey', passkeyUrl: turn.approval_url };
  }
  await setApproval(db, wallet, id, { status: 'failed', decidedAt, result: view });
  return { status: 'failed' };
}

export function parseCheckout(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const total = b.totalCents;
  if (!Number.isInteger(total) || (total as number) < 1 || (total as number) > 2_000_000) {
    throw new ValidationError('totalCents must be the checkout total in cents');
  }
  const merchant = typeof b.merchant === 'string' ? b.merchant.trim().slice(0, 120) : '';
  if (!merchant) throw new ValidationError('merchant is required');
  const url =
    typeof b.merchantUrl === 'string' && /^https?:\/\//.test(b.merchantUrl)
      ? b.merchantUrl.slice(0, 500)
      : null;
  const items = Array.isArray(b.items) ? (b.items as Record<string, unknown>[]) : [];
  return {
    merchant,
    merchantUrl: url,
    totalCents: total as number,
    items: items.slice(0, 20).map((i) => ({
      name: String(i.name ?? '').slice(0, 120),
      qty: Number.isInteger(i.qty) ? (i.qty as number) : 1,
      ...(Number.isInteger(i.priceCents) ? { priceCents: i.priceCents as number } : {})
    }))
  };
}

export async function getSettings(db: CredentialStore, wallet: string) {
  return { autoPayLimitCents: limitOf(await db.get(wallet)) };
}

export async function setAutoPayLimit(db: CredentialStore, wallet: string, cents: unknown) {
  if (!Number.isInteger(cents) || (cents as number) < 0 || (cents as number) > 1_000_000) {
    throw new ValidationError(
      'autoPayLimitCents must be a whole number of cents from 0 to 1000000'
    );
  }
  await db.update(wallet, (r) => ({ ...r, autoPayLimitCents: cents as number }));
  return { autoPayLimitCents: cents as number };
}

/** The saved cards' display fields, across every vault user this wallet has linked. */
export async function listWalletCards(db: CredentialStore, cards: AgentCard, wallet: string) {
  const users = (await db.get(wallet)).agentcardUsers ?? [];
  const lists = await Promise.all(users.map((u) => cards.listCards(u)));
  const seen = new Set<string>();
  return lists
    .flat()
    .filter((c) => !seen.has(c.id) && seen.add(c.id))
    .map(cardView);
}

// Add-a-card links stay usable side by side (the dashboard and an agent can
// each open one); only the most recent few are kept.
const SESSIONS_KEPT = 5;

const cardSessions = (r: WalletRecord): string[] =>
  r.agentcardSessions ?? (r.agentcardSession ? [r.agentcardSession] : []);

/** A single-use add-a-card link for the wallet. */
export async function startCardSession(db: CredentialStore, cards: AgentCard, wallet: string) {
  const latest = (await db.get(wallet)).agentcardUsers?.at(-1) ?? null;
  let session;
  let returning = !!latest;
  try {
    session = await cards.createVaultSession(latest);
  } catch (err) {
    // A passkey-only vault user has no phone or email for the sign-in code.
    // An open session still lets them pick "Unlock with your passkey". A user
    // from the other mode (sandbox vs live) is unknown here: start fresh too.
    const fresh = ['contact_missing', 'connection_not_found'];
    if (!(latest && err instanceof AgentCardError && fresh.includes(err.code))) throw err;
    session = await cards.createVaultSession(null);
    returning = false;
  }
  await db.update(wallet, (r) => ({
    ...r,
    agentcardSessions: [...cardSessions(r), session.id].slice(-SESSIONS_KEPT)
  }));
  return {
    sessionId: session.id,
    url: session.url,
    expiresAt: session.expires_at,
    pollInterval: session.poll_interval ?? 3,
    // A returning user gets a code by email or text before the card form.
    returning
  };
}

/**
 * Where the wallet's add-a-card session is. `linked` comes when the passkey
 * user exists; the card lands after that. Returns null for a session that
 * isn't this wallet's.
 */
export async function pollCardSession(
  db: CredentialStore,
  cards: AgentCard,
  wallet: string,
  id: string
) {
  const record = await db.get(wallet);
  if (!id || !cardSessions(record).includes(id)) return null;
  const session = await cards.getVaultSession(id);
  const user = session.user_id;
  if (user && !(record.agentcardUsers ?? []).includes(user)) {
    await db.update(wallet, (r) => ({
      ...r,
      agentcardUsers: [...(r.agentcardUsers ?? []), user]
    }));
  }
  // Once the user exists, take the tokens that let agents buy as them.
  if (user && record.agentcardConnection?.userId !== user) {
    await connectFromSession(db, cards, wallet, id);
  }
  return {
    status: session.status ?? 'pending',
    cardSaved: session.card === true || !!session.card_id,
    pollInterval: session.poll_interval ?? 3
  };
}

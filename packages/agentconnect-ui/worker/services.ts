// What the HTTP API and the MCP server both do for a wallet: saved cards,
// add-a-card sessions, and purchases through AgentCard.

import type { BuyRequest, BuyTurn } from './agentcard.ts';
import type { Env } from './index.ts';

import { AgentCard, AgentCardError } from './agentcard.ts';
import { CredentialStore } from './store.ts';

export function store(env: Env): CredentialStore | null {
  if (!env.CREDENTIALS || !env.CREDENTIALS_KEY) return null;
  return new CredentialStore(env.CREDENTIALS, env.CREDENTIALS_KEY);
}

export function agentCard(env: Env): AgentCard | null {
  if (!env.AGENTCARD_CLIENT_ID || !env.AGENTCARD_CLIENT_SECRET) return null;
  return new AgentCard({
    clientId: env.AGENTCARD_CLIENT_ID,
    clientSecret: env.AGENTCARD_CLIENT_SECRET
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

// What agents see of a purchase turn: enough to show the cart and act on it.
const turnView = (t: BuyTurn) => ({
  conversationId: t.conversation_id,
  status: t.status,
  reply: t.reply ?? null,
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

/**
 * One purchase turn for the wallet: shop with `ask`, place a shown cart with
 * `confirm`. Ships to the saved address and pays with the saved card, which
 * the owner approves with their passkey.
 */
export async function buyTurn(
  db: CredentialStore,
  cards: AgentCard,
  wallet: string,
  input: { ask?: string; conversationId?: string; confirm?: string }
): Promise<ReturnType<typeof turnView> | ReturnType<typeof addCardTurn>> {
  const token = await userToken(db, cards, wallet);
  // No card in the vault for purchases yet: answer with the link that adds one.
  if (!token) return addCardTurn(await startCardSession(db, cards, wallet));
  const { address } = await db.get(wallet);
  const body: BuyRequest = {};
  if (input.ask) body.ask = input.ask;
  if (input.conversationId) body.conversation_id = input.conversationId;
  if (input.confirm) {
    body.confirm = input.confirm;
    body.payment_source = 'vault';
  }
  if (address) {
    body.delivery_address = {
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
  return turnView(await cards.buy(token, body));
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

/** A single-use add-a-card link for the wallet. */
export async function startCardSession(db: CredentialStore, cards: AgentCard, wallet: string) {
  const latest = (await db.get(wallet)).agentcardUsers?.at(-1) ?? null;
  let session;
  let returning = !!latest;
  try {
    session = await cards.createVaultSession(latest);
  } catch (err) {
    // A passkey-only vault user has no phone or email for the sign-in code.
    // An open session still lets them pick "Unlock with your passkey".
    if (!(latest && err instanceof AgentCardError && err.code === 'contact_missing')) throw err;
    session = await cards.createVaultSession(null);
    returning = false;
  }
  await db.update(wallet, (r) => ({ ...r, agentcardSession: session.id }));
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
  if (!id || record.agentcardSession !== id) return null;
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

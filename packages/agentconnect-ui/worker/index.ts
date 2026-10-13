// agentconnect worker: the SPA (with SPA fallback) plus the credentials API
// that agents and the dashboard use for the owner's shipping address and cards.
// Saved details live in Workers KV (OMS customers need full KYC and don't
// accept metadata yet).

import type { AgentIdentity, OmsIdTokenConfig } from './agent-auth.ts';
import type { BuyRequest, BuyTurn } from './agentcard.ts';

import { AuthError, issueCertificate, verifyAccessToken, verifyEnrollToken } from './agent-auth.ts';
import { AgentCard, AgentCardError } from './agentcard.ts';
import { parseAddress, ValidationError } from './shipping.ts';
import { CredentialStore } from './store.ts';

export interface Env {
  ASSETS: Fetcher;
  CREDENTIALS?: KVNamespace;
  // Vars (wrangler.toml)
  OMS_ID_TOKEN_ISSUER?: string;
  OMS_ID_TOKEN_AUDIENCES?: string;
  OMS_JWKS_URL?: string;
  // Secrets (wrangler secret put)
  AGENT_CERT_SECRET?: string;
  CREDENTIALS_KEY?: string;
  AGENTCARD_CLIENT_ID?: string;
  AGENTCARD_CLIENT_SECRET?: string;
}

const DEFAULT_ISSUER = 'https://api.polygon.technology';
const DEFAULT_JWKS = 'https://api.polygon.technology/v1/WaasPublic/GetJWKS';
// The OMS project behind the CLI's default publishable key.
const DEFAULT_AUDIENCES = 'prj_01kqfw9zaykks';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function fail(status: number, error: string, message: string): Response {
  return json({ error, message }, status);
}

function idTokenConfig(env: Env): OmsIdTokenConfig {
  return {
    jwksUrl: env.OMS_JWKS_URL || DEFAULT_JWKS,
    issuer: env.OMS_ID_TOKEN_ISSUER || DEFAULT_ISSUER,
    audiences: (env.OMS_ID_TOKEN_AUDIENCES || DEFAULT_AUDIENCES)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  };
}

function store(env: Env): CredentialStore | null {
  if (!env.CREDENTIALS || !env.CREDENTIALS_KEY) return null;
  return new CredentialStore(env.CREDENTIALS, env.CREDENTIALS_KEY);
}

function agentCard(env: Env): AgentCard | null {
  if (!env.AGENTCARD_CLIENT_ID || !env.AGENTCARD_CLIENT_SECRET) return null;
  return new AgentCard({
    clientId: env.AGENTCARD_CLIENT_ID,
    clientSecret: env.AGENTCARD_CLIENT_SECRET
  });
}

const cardView = (c: {
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
async function connectFromSession(
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
async function userToken(
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
): Promise<ReturnType<typeof turnView>> {
  const token = await userToken(db, cards, wallet);
  if (!token) {
    throw new ValidationError(
      'No card is connected for purchases yet. Connect a card on the dashboard Wallet page first.'
    );
  }
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

async function authenticate(req: Request, env: Env): Promise<AgentIdentity> {
  const header = req.headers.get('Authorization') ?? '';
  const m = /^Agent\s+(\S+)$/.exec(header);
  if (!m) throw new AuthError('unauthorized', 'Send Authorization: Agent <token>');
  return verifyAccessToken(m[1], env.AGENT_CERT_SECRET!);
}

async function readBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ValidationError('Request body must be JSON');
  }
}

export function parseBuy(body: unknown): {
  ask?: string;
  conversationId?: string;
  confirm?: string;
} {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === 'string' && (b[k] as string).trim()) || undefined;
  const out = { ask: str('ask'), conversationId: str('conversationId'), confirm: str('confirm') };
  if (!out.ask && !out.confirm)
    throw new ValidationError('Send ask, or confirm with conversationId');
  if (out.confirm && !out.conversationId) throw new ValidationError('confirm needs conversationId');
  if (out.confirm && !/^[0-9a-f]{16}$/.test(out.confirm)) {
    throw new ValidationError('confirm must be the cart hash (16 hex characters)');
  }
  if (out.ask && out.ask.length > 2000) throw new ValidationError('ask is too long');
  return out;
}

export async function handleApi(req: Request, env: Env, path: string): Promise<Response> {
  if (!env.AGENT_CERT_SECRET) {
    return fail(
      503,
      'credentials_unavailable',
      'Credentials are not configured on this deployment'
    );
  }
  try {
    if (path === '/api/agent/enroll') {
      if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST');
      const body = (await readBody(req)) as { idToken?: unknown };
      if (typeof body?.idToken !== 'string') throw new ValidationError('idToken is required');
      const claims = await verifyEnrollToken(body.idToken, idTokenConfig(env));
      const cert = await issueCertificate(claims, env.AGENT_CERT_SECRET);
      return json({ ...cert, wallet: claims.wallet, agentKey: claims.agentKey });
    }

    if (path === '/api/credentials/address') {
      const who = await authenticate(req, env);
      const db = store(env);
      if (!db) return fail(503, 'credentials_unavailable', 'Address storage is not configured');

      if (req.method === 'GET') {
        const r = await db.get(who.wallet);
        return json({ address: r.address ?? null });
      }
      if (req.method === 'PUT') {
        const address = parseAddress(await readBody(req));
        await db.update(who.wallet, (r) => ({ ...r, address }));
        return json({ address });
      }
      if (req.method === 'DELETE') {
        await db.update(who.wallet, (r) => ({ ...r, address: null }));
        return json({ address: null });
      }
      return fail(405, 'method_not_allowed', 'Use GET, PUT, or DELETE');
    }

    // POST /api/credentials/buy: one purchase turn ({ ask } or { conversationId, confirm }).
    if (path === '/api/credentials/buy') {
      if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST');
      const who = await authenticate(req, env);
      const db = store(env);
      const cards = agentCard(env);
      if (!db || !cards) return fail(503, 'credentials_unavailable', 'Cards are not configured');
      return json(await buyTurn(db, cards, who.wallet, parseBuy(await readBody(req))));
    }

    if (path.startsWith('/api/credentials/cards')) {
      const who = await authenticate(req, env);
      const db = store(env);
      const cards = agentCard(env);
      if (!db || !cards) return fail(503, 'credentials_unavailable', 'Cards are not configured');

      // GET /api/credentials/cards: the saved cards' display fields, across every
      // vault user this wallet has linked.
      if (path === '/api/credentials/cards' && req.method === 'GET') {
        const users = (await db.get(who.wallet)).agentcardUsers ?? [];
        const lists = await Promise.all(users.map((u) => cards.listCards(u)));
        const seen = new Set<string>();
        const all = lists.flat().filter((c) => !seen.has(c.id) && seen.add(c.id));
        return json({ cards: all.map(cardView) });
      }

      // POST /api/credentials/cards/session: a single-use add-a-card link.
      if (path === '/api/credentials/cards/session' && req.method === 'POST') {
        const latest = (await db.get(who.wallet)).agentcardUsers?.at(-1) ?? null;
        let session;
        let returning = !!latest;
        try {
          session = await cards.createVaultSession(latest);
        } catch (err) {
          // A passkey-only vault user has no phone or email for the sign-in code.
          // An open session still lets them pick "Unlock with your passkey".
          if (!(latest && err instanceof AgentCardError && err.code === 'contact_missing'))
            throw err;
          session = await cards.createVaultSession(null);
          returning = false;
        }
        await db.update(who.wallet, (r) => ({ ...r, agentcardSession: session.id }));
        return json({
          sessionId: session.id,
          url: session.url,
          expiresAt: session.expires_at,
          pollInterval: session.poll_interval ?? 3,
          // A returning user gets a code by email or text before the card form.
          returning
        });
      }

      // GET /api/credentials/cards/session?id=vs_...: poll until the card is saved.
      // `linked` comes when the passkey user exists; the card lands after that.
      if (path === '/api/credentials/cards/session' && req.method === 'GET') {
        const id = new URL(req.url).searchParams.get('id') ?? '';
        const record = await db.get(who.wallet);
        if (!id || record.agentcardSession !== id) {
          return fail(404, 'not_found', 'No such add-a-card session for this wallet');
        }
        const session = await cards.getVaultSession(id);
        const user = session.user_id;
        if (user && !(record.agentcardUsers ?? []).includes(user)) {
          await db.update(who.wallet, (r) => ({
            ...r,
            agentcardUsers: [...(r.agentcardUsers ?? []), user]
          }));
        }
        // Once the user exists, take the tokens that let agents buy as them.
        if (user && record.agentcardConnection?.userId !== user) {
          await connectFromSession(db, cards, who.wallet, id);
        }
        return json({
          status: session.status ?? 'pending',
          cardSaved: session.card === true || !!session.card_id,
          pollInterval: session.poll_interval ?? 3
        });
      }

      return fail(405, 'method_not_allowed', 'Unsupported cards request');
    }

    return fail(404, 'not_found', 'No such endpoint');
  } catch (err) {
    if (err instanceof AuthError) {
      return fail(401, err.code, err.message);
    }
    if (err instanceof ValidationError) return fail(400, 'invalid_request', err.message);
    if (err instanceof AgentCardError) {
      console.error('[agentcard]', err.status, err.code, err.message);
      if (err.status === 429)
        return fail(429, 'rate_limited', 'Too many card requests. Try again in a minute.');
      return fail(502, 'upstream_error', 'The card service is unavailable. Try again shortly.');
    }
    console.error('[api]', err);
    return fail(500, 'internal_error', 'Something went wrong');
  }
}

// Cloudflare Workers require a default export.
// eslint-disable-next-line import-x/no-default-export
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) return handleApi(request, env, url.pathname);

    if (!env.ASSETS) {
      return new Response('ASSETS binding is missing', { status: 500 });
    }

    // SPA fallback: serve index.html for non-file paths.
    const res = await env.ASSETS.fetch(request);
    if (res.status !== 404) return res;

    if (/\.[a-z0-9]+$/i.test(url.pathname)) return res;

    const indexUrl = new URL(request.url);
    indexUrl.pathname = '/index.html';
    return env.ASSETS.fetch(new Request(indexUrl.toString(), request));
  }
};

// agentconnect worker: the SPA (with SPA fallback) plus the credentials API
// that agents and the dashboard use for the owner's shipping address and cards.
// Saved details live in Workers KV (OMS customers need full KYC and don't
// accept metadata yet).

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

import { OAuthProvider } from '@cloudflare/workers-oauth-provider';

import type { AgentIdentity, OmsIdTokenConfig } from './agent-auth.ts';
import type { McpProps } from './mcp.ts';

import { AuthError, issueCertificate, verifyAccessToken, verifyEnrollToken } from './agent-auth.ts';
import { AgentCardError, agentCardFailure } from './agentcard.ts';
import { handleMcp } from './mcp.ts';
import {
  issueSession,
  sessionCookie,
  sessionIdentity,
  verifySession,
  readSessionCookie
} from './owner-session.ts';
import { OwnerSignIn } from './owner-signin.ts';
import { policyOf, profileForClient } from './profiles.ts';
import {
  agentCard,
  approvalForPage,
  approvalStatus,
  authorizeCheckout,
  buyTurn,
  decideApproval,
  getSettings,
  parseCheckout,
  setAutoPayLimit,
  listWalletCards,
  pollCardSession,
  startCardSession,
  store
} from './services.ts';
import { parseAddress, ValidationError } from './shipping.ts';
import { SealedKv } from './store.ts';
import { walletLock } from './wallet-lock.ts';

export interface Env {
  ASSETS: Fetcher;
  CREDENTIALS?: KVNamespace;
  // MCP: OAuth grants and tokens (the provider's own records), and its helpers.
  OAUTH_KV?: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
  // Vars (wrangler.toml)
  OMS_ID_TOKEN_ISSUER?: string;
  OMS_ID_TOKEN_AUDIENCES?: string;
  OMS_JWKS_URL?: string;
  // Secrets (wrangler secret put)
  AGENT_CERT_SECRET?: string;
  CREDENTIALS_KEY?: string;
  AGENTCARD_CLIENT_ID?: string;
  AGENTCARD_CLIENT_SECRET?: string;
  // "on" asks owners for app auto-approval when they add a card (production).
  AGENTCARD_AUTO_APPROVAL?: string;
  // Read balances for the MCP get_wallet tool.
  INDEXER_ACCESS_KEY?: string;
  // OMS project the MCP sign-in uses; defaults to the CLI's.
  OMS_PUBLISHABLE_KEY?: string;
  // MCP clients with their own rules: JSON, OAuth client id to profile (profiles.ts).
  MCP_CLIENT_PROFILES?: string;
  // One Durable Object per wallet: atomic payment claims (wallet-lock.ts).
  WALLET_LOCK?: DurableObjectNamespace;
  // Caps MCP client registrations per address (wrangler.toml ratelimits).
  REGISTER_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

const DEFAULT_PUBLISHABLE_KEY = 'pk_sdbx_01kqfw9zaykks_01kwvkkzs5e2wb6rfas2y2njm8';

function ownerSignIn(env: Env): OwnerSignIn | null {
  if (!env.OAUTH_KV || !env.CREDENTIALS_KEY) return null;
  return new OwnerSignIn(
    new SealedKv(env.OAUTH_KV, env.CREDENTIALS_KEY),
    env.OMS_PUBLISHABLE_KEY || DEFAULT_PUBLISHABLE_KEY
  );
}

const DEFAULT_ISSUER = 'https://api.polygon.technology';
const DEFAULT_JWKS = 'https://api.polygon.technology/v1/WaasPublic/GetJWKS';
// The OMS project behind the CLI's default publishable key.
const DEFAULT_AUDIENCES = 'prj_01kqfw9zaykks';

// An agent on the owner's own machine gets its sign-in on localhost (Claude
// Code, Codex) or through an app link (Cursor), where nothing more happens. A
// hosted one (claude.ai, Muse) carries on from its own page.
export function isLocalAgent(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol === 'https:') return false;
    if (protocol !== 'http:') return true;
    return (
      hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname)
    );
  } catch {
    return false;
  }
}

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

// An agent's signed token, or the owner's own sign-in on this site.
async function authenticate(req: Request, env: Env): Promise<AgentIdentity> {
  const header = req.headers.get('Authorization') ?? '';
  const m = /^Agent\s+(\S+)$/.exec(header);
  if (m) return verifyAccessToken(m[1], env.AGENT_CERT_SECRET!);
  const owner = await sessionIdentity(req, env.AGENT_CERT_SECRET!);
  if (owner) return owner;
  throw new AuthError('unauthorized', 'Sign in, or send Authorization: Agent <token>');
}

async function readBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ValidationError('Request body must be JSON');
  }
}

export function parseBuy(body: unknown): { ask: string; conversationId?: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === 'string' && (b[k] as string).trim()) || undefined;
  const ask = str('ask');
  if (!ask) throw new ValidationError('ask is required: what to buy, or the answer to a question');
  if (ask.length > 2000) throw new ValidationError('ask is too long');
  return { ask, conversationId: str('conversationId') };
}

/**
 * The connect page, like a card wallet's agent consent screen: the owner signs
 * in (or is already signed in on this site), sees what the agent will be able
 * to do, and allows or denies. Allowing issues the grant; either way the page
 * goes back to the agent.
 */
export async function handleConnectApi(req: Request, env: Env, path: string): Promise<Response> {
  const signIn = ownerSignIn(env);
  if (!signIn || !env.OAUTH_PROVIDER || !env.AGENT_CERT_SECRET) {
    return fail(503, 'mcp_unavailable', 'Connecting agents is not configured on this deployment');
  }
  const profileOf = (clientId: string) => profileForClient(env.MCP_CLIENT_PROFILES, clientId);
  // What the consent screen shows once the owner is known.
  const consent = async (
    who: { wallet: string; email: string | null },
    request: { clientId: string; redirectUri: string } | undefined
  ) => {
    const db = store(env);
    const limit = db ? (await getSettings(db, who.wallet)).autoPayLimitCents : null;
    return {
      signedIn: true,
      email: who.email,
      autoPayLimitCents: limit,
      confirmsEachPurchase: policyOf(profileOf(request?.clientId ?? '')).confirmEachPurchase,
      // On the owner's own machine: after allowing, the dashboard opens in front.
      localAgent: isLocalAgent(request?.redirectUri ?? '')
    };
  };
  try {
    if (path === '/api/connect' && req.method === 'GET') {
      const id = new URL(req.url).searchParams.get('c') ?? '';
      const pending = await signIn.load(id);
      if (!pending.authRequest)
        throw new ValidationError('This link is not for connecting an agent.');
      const base = { clientName: pending.clientName };
      if (pending.signedIn) {
        return json({ ...base, ...(await consent(pending.signedIn, pending.authRequest)) });
      }
      // Already signed in on this site: straight to the consent screen.
      const token = readSessionCookie(req);
      const who = token
        ? await verifySession(token, env.AGENT_CERT_SECRET).catch(() => null)
        : null;
      if (who) {
        await signIn.markSignedIn(id, who);
        return json({ ...base, ...(await consent(who, pending.authRequest)) });
      }
      return json({ ...base, signedIn: false });
    }
    if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST');
    const body = (await readBody(req)) as Record<string, unknown>;
    const id = typeof body.c === 'string' ? body.c : '';
    const str = (k: string) => {
      const v = body[k];
      if (typeof v !== 'string' || !v.trim()) throw new ValidationError(`${k} is required`);
      return v.trim();
    };
    // Signed in: remember who, keep them signed in on the site, show consent.
    const signedIn = async (who: { wallet: string; email: string | null }) => {
      await signIn.markSignedIn(id, who);
      const request = (await signIn.load(id)).authRequest;
      return new Response(JSON.stringify(await consent(who, request)), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Set-Cookie': sessionCookie(req, await issueSession(who, env.AGENT_CERT_SECRET!))
        }
      });
    };
    if (path === '/api/connect/email/start') {
      await signIn.startEmail(id, str('email'));
      return json({ sent: true });
    }
    if (path === '/api/connect/email/finish') {
      return signedIn(await signIn.finishEmail(id, str('code')));
    }
    if (path === '/api/connect/google/start') {
      const url = await signIn.startGoogle(id, `${new URL(req.url).origin}/login`);
      return json({ url });
    }
    if (path === '/api/connect/google/finish') {
      return signedIn(await signIn.finishGoogle(id, str('callbackUrl')));
    }
    if (path === '/api/connect/decide') {
      const pending = await signIn.load(id);
      if (!pending.authRequest)
        throw new ValidationError('This link is not for connecting an agent.');
      if (!pending.signedIn) throw new ValidationError('Sign in first.');
      const who = pending.signedIn;
      await signIn.forget(id);
      if (body.allow !== true) {
        const back = new URL(pending.authRequest.redirectUri);
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('error_description', 'The owner did not allow access');
        if (pending.authRequest.state) back.searchParams.set('state', pending.authRequest.state);
        return json({ redirectTo: back.toString() });
      }
      // The profile is fixed for this connection's life.
      const profile = profileOf(pending.authRequest.clientId);
      const props: McpProps = { wallet: who.wallet, email: who.email, profile };
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: pending.authRequest,
        userId: who.wallet,
        metadata: { clientName: pending.clientName, email: who.email, profile },
        scope: pending.authRequest.scope,
        props
      });
      return json({ redirectTo });
    }
    return fail(404, 'not_found', 'No such endpoint');
  } catch (err) {
    if (err instanceof ValidationError) return fail(400, 'invalid_request', err.message);
    console.error('[connect]', err);
    const message = err instanceof Error ? err.message : '';
    // OMS refusals (a wrong code, an expired one) are the owner's to fix.
    if (/code|otp|expired|invalid/i.test(message)) {
      return fail(
        400,
        'sign_in_failed',
        'That sign-in did not work. Check the code and try again.'
      );
    }
    return fail(500, 'internal_error', 'Something went wrong');
  }
}

/**
 * Agents connected to the wallet (MCP grants), for the dashboard's Settings.
 * Only the owner signed in on this site may list or disconnect them.
 */
export async function handleAgentsApi(req: Request, env: Env, path: string): Promise<Response> {
  if (!env.OAUTH_PROVIDER || !env.AGENT_CERT_SECRET) {
    return fail(503, 'mcp_unavailable', 'Connecting agents is not configured on this deployment');
  }
  try {
    const owner = await sessionIdentity(req, env.AGENT_CERT_SECRET);
    if (!owner) return fail(401, 'unauthorized', 'Sign in to see connected agents');
    if (path === '/api/agents' && req.method === 'GET') {
      const agents = [];
      let cursor: string | undefined;
      do {
        const page = await env.OAUTH_PROVIDER.listUserGrants(owner.wallet, { cursor });
        for (const g of page.items) {
          const meta = (g.metadata ?? {}) as { clientName?: string };
          agents.push({ id: g.id, name: agentName(meta.clientName), connectedAt: g.createdAt });
        }
        cursor = page.cursor;
      } while (cursor);
      agents.sort((a, b) => b.connectedAt - a.connectedAt);
      return json({ agents });
    }
    const m = /^\/api\/agents\/([^/]+)$/.exec(path);
    if (m && req.method === 'DELETE') {
      await env.OAUTH_PROVIDER.revokeGrant(decodeURIComponent(m[1]), owner.wallet);
      return json({ disconnected: true });
    }
    return fail(404, 'not_found', 'No such endpoint');
  } catch (err) {
    if (err instanceof AuthError) return fail(401, err.code, err.message);
    console.error('[agents]', err);
    return fail(500, 'internal_error', 'Something went wrong');
  }
}

/**
 * The approval page: show the purchase, sign the owner in (email code or
 * Google, by the worker), and record their decision. The agent waiting on the
 * approval sees it on its next status check.
 */
export async function handleApproveApi(req: Request, env: Env, path: string): Promise<Response> {
  const signIn = ownerSignIn(env);
  const db = store(env);
  const cards = agentCard(env);
  if (!signIn || !db || !cards) {
    return fail(503, 'approvals_unavailable', 'Approvals are not configured on this deployment');
  }
  try {
    if (path === '/api/approve' && req.method === 'GET') {
      const found = await approvalForPage(db, new URL(req.url).searchParams.get('r') ?? '');
      if (!found) return fail(404, 'not_found', 'This approval link is not valid.');
      const a = found.approval;
      const c = a.status === 'pending' ? await signIn.create({ approvalId: a.id }) : null;
      return json({
        merchant: a.merchant,
        merchantUrl: a.merchantUrl,
        totalCents: a.totalCents,
        items: a.items,
        kind: a.kind,
        status: a.status,
        c
      });
    }
    if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST');
    const body = (await readBody(req)) as Record<string, unknown>;
    const id = typeof body.c === 'string' ? body.c : '';
    const str = (k: string) => {
      const v = body[k];
      if (typeof v !== 'string' || !v.trim()) throw new ValidationError(`${k} is required`);
      return v.trim();
    };
    const signedIn = async (who: { wallet: string; email: string | null }) => {
      await signIn.markSignedIn(id, who);
      return json({ signedIn: true, email: who.email });
    };
    if (path === '/api/approve/email/start') {
      await signIn.startEmail(id, str('email'));
      return json({ sent: true });
    }
    if (path === '/api/approve/email/finish')
      return signedIn(await signIn.finishEmail(id, str('code')));
    if (path === '/api/approve/google/start') {
      return json({ url: await signIn.startGoogle(id, `${new URL(req.url).origin}/login`) });
    }
    if (path === '/api/approve/google/finish') {
      return signedIn(await signIn.finishGoogle(id, str('callbackUrl')));
    }
    if (path === '/api/approve/decide') {
      const pending = await signIn.load(id);
      if (!pending.approvalId || !pending.signedIn) throw new ValidationError('Sign in first.');
      const result = await decideApproval(
        db,
        cards,
        pending.approvalId,
        pending.signedIn.wallet,
        body.approve === true,
        walletLock(env, pending.signedIn.wallet)
      );
      await signIn.forget(id);
      return json(result);
    }
    return fail(404, 'not_found', 'No such endpoint');
  } catch (err) {
    if (err instanceof ValidationError) return fail(400, 'invalid_request', err.message);
    if (err instanceof AgentCardError) {
      console.error('[approve agentcard]', err.status, err.code, err.message);
      const f = agentCardFailure(err);
      return fail(f.status, f.code, f.message);
    }
    console.error('[approve]', err);
    const message = err instanceof Error ? err.message : '';
    if (/code|otp|expired|invalid/i.test(message)) {
      return fail(
        400,
        'sign_in_failed',
        'That sign-in did not work. Check the code and try again.'
      );
    }
    return fail(500, 'internal_error', 'Something went wrong');
  }
}

/**
 * Signing in on the site: email code or Google (by the worker, like the
 * connect page), ending in a session cookie for the agent wallet.
 */
export async function handleSessionApi(req: Request, env: Env, path: string): Promise<Response> {
  const signIn = ownerSignIn(env);
  if (!signIn || !env.AGENT_CERT_SECRET) {
    return fail(503, 'signin_unavailable', 'Signing in is not configured on this deployment');
  }
  try {
    if (path === '/api/session') {
      if (req.method === 'GET') {
        const token = readSessionCookie(req);
        if (!token) return fail(401, 'unauthorized', 'Not signed in');
        return json(await verifySession(token, env.AGENT_CERT_SECRET));
      }
      if (req.method === 'DELETE') {
        return new Response(JSON.stringify({ signedIn: false }), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Set-Cookie': sessionCookie(req, null)
          }
        });
      }
      return fail(405, 'method_not_allowed', 'Use GET or DELETE');
    }
    if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST');
    const body = (await readBody(req)) as Record<string, unknown>;
    const str = (k: string) => {
      const v = body[k];
      if (typeof v !== 'string' || !v.trim()) throw new ValidationError(`${k} is required`);
      return v.trim();
    };
    const finish = async (id: string, signedIn: { wallet: string; email: string | null }) => {
      await signIn.forget(id);
      // The owner's agent wallet, when an agent linked under this email.
      const linked = signedIn.email ? await store(env)?.ownerWallet(signedIn.email) : null;
      const who = linked ? { ...signedIn, wallet: linked } : signedIn;
      return new Response(JSON.stringify(who), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Set-Cookie': sessionCookie(req, await issueSession(who, env.AGENT_CERT_SECRET!))
        }
      });
    };
    if (path === '/api/session/email/start') {
      const c = await signIn.create({});
      await signIn.startEmail(c, str('email'));
      return json({ c });
    }
    if (path === '/api/session/email/finish') {
      const c = str('c');
      return finish(c, await signIn.finishEmail(c, str('code')));
    }
    if (path === '/api/session/google/start') {
      const c = await signIn.create({});
      return json({ c, url: await signIn.startGoogle(c, `${new URL(req.url).origin}/login`) });
    }
    if (path === '/api/session/google/finish') {
      const c = str('c');
      return finish(c, await signIn.finishGoogle(c, str('callbackUrl')));
    }
    return fail(404, 'not_found', 'No such endpoint');
  } catch (err) {
    if (err instanceof AuthError) return fail(401, err.code, err.message);
    if (err instanceof ValidationError) return fail(400, 'invalid_request', err.message);
    console.error('[session]', err);
    const message = err instanceof Error ? err.message : '';
    if (/code|otp|expired|invalid/i.test(message)) {
      return fail(
        400,
        'sign_in_failed',
        'That sign-in did not work. Check the code and try again.'
      );
    }
    return fail(500, 'internal_error', 'Something went wrong');
  }
}

/**
 * The agent's name as the owner knows it. MCP clients often add the server's
 * label, as in "Claude Code (polygon-wallet)"; drop that.
 */
export function agentName(clientName: string | undefined): string {
  return (clientName ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim() || 'An agent';
}

/** GET /authorize: an MCP client wants access. Hand off to the connect page. */
async function handleAuthorize(req: Request, env: Env): Promise<Response> {
  const signIn = ownerSignIn(env);
  if (!signIn || !env.OAUTH_PROVIDER) {
    return new Response('Connecting agents is not configured on this deployment', { status: 503 });
  }
  const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(req);
  const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  if (!client) return new Response('Unknown client', { status: 400 });
  const id = await signIn.create({ authRequest, clientName: agentName(client.clientName) });
  return Response.redirect(`${new URL(req.url).origin}/connect?c=${id}`, 302);
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
      // So the owner's dashboard sign-in opens this wallet, whichever way they sign in.
      if (claims.email) await store(env)?.linkOwner(claims.email, claims.wallet);
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

    // Purchases: POST /api/credentials/buy ({ ask, conversationId? }),
    // POST /api/credentials/checkout (before paying in the agent's browser),
    // GET /api/credentials/approvals/<id>?wait=<seconds>, and the owner's
    // auto-pay limit at /api/credentials/settings.
    if (
      path === '/api/credentials/buy' ||
      path === '/api/credentials/checkout' ||
      path === '/api/credentials/settings' ||
      path.startsWith('/api/credentials/approvals/')
    ) {
      const who = await authenticate(req, env);
      const db = store(env);
      const cards = agentCard(env);
      if (!db || !cards) return fail(503, 'credentials_unavailable', 'Cards are not configured');
      const origin = new URL(req.url).origin;
      if (path === '/api/credentials/buy' && req.method === 'POST') {
        return json(await buyTurn(db, cards, who.wallet, parseBuy(await readBody(req)), origin));
      }
      if (path === '/api/credentials/checkout' && req.method === 'POST') {
        return json(
          await authorizeCheckout(db, who.wallet, parseCheckout(await readBody(req)), origin)
        );
      }
      if (path === '/api/credentials/settings') {
        if (req.method === 'GET') return json(await getSettings(db, who.wallet));
        if (req.method === 'PUT') {
          const body = (await readBody(req)) as { autoPayLimitCents?: unknown };
          return json(await setAutoPayLimit(db, who.wallet, body?.autoPayLimitCents));
        }
      }
      const m = /^\/api\/credentials\/approvals\/(apr_[0-9a-f]{24})$/.exec(path);
      if (m && req.method === 'GET') {
        const wait = Math.min(
          25,
          Math.max(0, Number(new URL(req.url).searchParams.get('wait') ?? 0) || 0)
        );
        const status = await approvalStatus(db, cards, who.wallet, m[1], origin, wait * 1000);
        if (!status) return fail(404, 'not_found', 'No such approval for this wallet');
        return json(status);
      }
      return fail(405, 'method_not_allowed', 'Unsupported purchase request');
    }

    if (path.startsWith('/api/credentials/cards')) {
      const who = await authenticate(req, env);
      const db = store(env);
      const cards = agentCard(env);
      if (!db || !cards) return fail(503, 'credentials_unavailable', 'Cards are not configured');

      if (path === '/api/credentials/cards' && req.method === 'GET') {
        return json({ cards: await listWalletCards(db, cards, who.wallet) });
      }

      // POST /api/credentials/cards/session: a single-use add-a-card link.
      if (path === '/api/credentials/cards/session' && req.method === 'POST') {
        return json(await startCardSession(db, cards, who.wallet));
      }

      // GET /api/credentials/cards/session?id=vs_...: poll until the card is saved.
      if (path === '/api/credentials/cards/session' && req.method === 'GET') {
        const id = new URL(req.url).searchParams.get('id') ?? '';
        const status = await pollCardSession(db, cards, who.wallet, id);
        if (!status) return fail(404, 'not_found', 'No such add-a-card session for this wallet');
        return json(status);
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
      const f = agentCardFailure(err);
      return fail(f.status, f.code, f.message);
    }
    console.error('[api]', err);
    return fail(500, 'internal_error', 'Something went wrong');
  }
}

// The site: the SPA (with SPA fallback), the credentials API, and the MCP
// connect flow. The OAuth provider sits in front of it for /mcp.
const app = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/authorize') return handleAuthorize(request, env);
    if (url.pathname.startsWith('/api/connect'))
      return handleConnectApi(request, env, url.pathname);
    if (url.pathname.startsWith('/api/approve'))
      return handleApproveApi(request, env, url.pathname);
    if (url.pathname === '/api/agents' || url.pathname.startsWith('/api/agents/'))
      return handleAgentsApi(request, env, url.pathname);
    if (url.pathname === '/api/session' || url.pathname.startsWith('/api/session/'))
      return handleSessionApi(request, env, url.pathname);
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

// One provider per origin: the protected resource is this deployment's /mcp.
const providers = new Map<string, OAuthProvider<Env>>();
function oauthFor(origin: string): OAuthProvider<Env> {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: {
        fetch: (request, env, ctx) =>
          handleMcp(request, env, (ctx as ExecutionContext & { props: McpProps }).props)
      },
      defaultHandler: app,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: ['wallet'],
      resourceMetadata: {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ['wallet'],
        bearer_methods_supported: ['header'],
        resource_name: 'Polygon agent wallet'
      }
    });
    providers.set(origin, p);
  }
  return p;
}

/**
 * Anyone may register an MCP client, so registrations are capped per address
 * (the REGISTER_LIMITER binding). Returns the 429 to send, or null to go on.
 */
export async function limitRegistration(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/oauth/register') return null;
  if (!env.REGISTER_LIMITER) return null;
  const key = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const { success } = await env.REGISTER_LIMITER.limit({ key });
  if (success) return null;
  return Response.json(
    { error: 'rate_limited', error_description: 'Too many registrations. Try again in a minute.' },
    { status: 429, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } }
  );
}

// The Durable Object class wrangler binds as WALLET_LOCK.
export { WalletLock } from './wallet-lock.ts';

// Cloudflare Workers require a default export. Without the OAuth store the
// site still runs; /mcp answers 404.
// eslint-disable-next-line import-x/no-default-export
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.OAUTH_KV) return app.fetch(request, env);
    const limited = await limitRegistration(request, env);
    if (limited) return limited;
    return oauthFor(new URL(request.url).origin).fetch(request, env, ctx);
  }
};

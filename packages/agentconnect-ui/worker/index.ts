// agentconnect worker: the SPA (with SPA fallback), the owner's sign-in on the
// site, and connecting agents over MCP.

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

import { AuthorizationError, OAuthProvider } from '@cloudflare/workers-oauth-provider';

import type { McpProps } from './mcp.ts';

import { AuthError } from './agent-auth.ts';
import { handleMcp } from './mcp.ts';
import { agentKey } from './money/agent-key.ts';
import { setUpAllowance } from './money/connect.ts';
import { MoneyError } from './money/errors.ts';
import { runAsOwner } from './money/owner-run.ts';
import {
  DEFAULT_ALLOWANCE_USD,
  DEFAULT_DAYS,
  MAX_ALLOWANCE_USD,
  MAX_DAYS,
  MIN_ALLOWANCE_USD,
  priceKey
} from './money/plan.ts';
import { publishableKey } from './oms-config.ts';
import {
  issueSession,
  sessionCookie,
  sessionIdentity,
  verifySession,
  readSessionCookie
} from './owner-session.ts';
import { OwnerSignIn, ValidationError } from './owner-signin.ts';
import { policyOf, profileForClient } from './profiles.ts';
import { SealedKv } from './store.ts';

// Each connection that moves money has its own key in a Durable Object.
export { AgentKey } from './money/agent-key.ts';

export interface Env {
  ASSETS: Fetcher;
  // MCP: OAuth grants and tokens (the provider's own records), and its helpers.
  OAUTH_KV?: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
  // Secrets (wrangler secret put): the session cookie's HMAC key, and the key
  // that seals sign-ins in progress.
  AGENT_CERT_SECRET?: string;
  CREDENTIALS_KEY?: string;
  // Read balances for the MCP get_wallet tool.
  INDEXER_ACCESS_KEY?: string;
  // Each MCP connection's key and allowance (money/agent-key.ts), and Trails
  // for its prices, swaps and bridges.
  AGENT_KEYS?: DurableObjectNamespace;
  TRAILS_API_KEY?: string;
  // OMS project the MCP sign-in uses; defaults to the CLI's.
  OMS_PUBLISHABLE_KEY?: string;
  // MCP clients with their own rules: JSON, OAuth client id to profile (profiles.ts).
  MCP_CLIENT_PROFILES?: string;
  // The token OpenAI's plugin portal asks this domain to serve, to prove we own it.
  OPENAI_APPS_CHALLENGE?: string;
  // Caps MCP client registrations per address (wrangler.toml ratelimits).
  REGISTER_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

function ownerSignIn(env: Env): OwnerSignIn | null {
  if (!env.OAUTH_KV || !env.CREDENTIALS_KEY) return null;
  return new OwnerSignIn(new SealedKv(env.OAUTH_KV, env.CREDENTIALS_KEY), publishableKey(env));
}

const hexId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');

async function trailsPrices(env: Env, tokens: { chainId: number; address: string }[]) {
  const prices = new Map<string, number>();
  if (tokens.length === 0) return prices;
  const { TrailsApi } = await import('@0xtrails/api');
  const res = await new TrailsApi(env.TRAILS_API_KEY ?? '').getTokenPrices({
    tokens: tokens.map((t) => ({ chainId: t.chainId, tokenAddress: t.address }))
  });
  for (const entry of res.tokenPrices ?? []) {
    if (typeof entry.priceUsd === 'number' && entry.priceUsd > 0) {
      prices.set(priceKey(entry.token.chainId, entry.token.tokenAddress), entry.priceUsd);
    }
  }
  return prices;
}

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

async function readBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ValidationError('Request body must be JSON');
  }
}

/**
 * The connect page, an agent consent screen: the owner signs
 * in (or is already signed in on this site), sees what the agent will be able
 * to do, and allows or denies. Allowing issues the grant; either way the page
 * goes back to the agent.
 */
export async function handleConnectApi(req: Request, env: Env, path: string): Promise<Response> {
  const signIn = ownerSignIn(env);
  if (!signIn || !env.OAUTH_PROVIDER || !env.AGENT_CERT_SECRET) {
    return fail(503, 'mcp_unavailable', 'Connecting agents is not configured on this deployment');
  }
  // The profile follows the client and where it sends the owner back.
  const profileOf = (request: { clientId: string; redirectUri: string }) =>
    profileForClient(env.MCP_CLIENT_PROFILES, request.clientId, [request.redirectUri]);
  const movesMoney = (request: { clientId: string; redirectUri: string } | undefined) =>
    !!request && policyOf(profileOf(request)).movesMoney && !!env.AGENT_KEYS;
  // What the consent screen shows once the owner is known.
  const consent = (
    who: { wallet: string; email: string | null },
    request: { clientId: string; redirectUri: string } | undefined
  ) => ({
    signedIn: true,
    email: who.email,
    // On the owner's own machine: after allowing, the dashboard opens in front.
    localAgent: isLocalAgent(request?.redirectUri ?? ''),
    // An agent that may move money asks for an allowance to spend from.
    ...(movesMoney(request)
      ? {
          spending: {
            defaultUsd: DEFAULT_ALLOWANCE_USD,
            defaultDays: DEFAULT_DAYS,
            minUsd: MIN_ALLOWANCE_USD,
            maxUsd: MAX_ALLOWANCE_USD,
            maxDays: MAX_DAYS
          }
        }
      : {})
  });
  try {
    if (path === '/api/connect' && req.method === 'GET') {
      const id = new URL(req.url).searchParams.get('c') ?? '';
      const pending = await signIn.load(id);
      if (!pending.authRequest)
        throw new ValidationError('This link is not for connecting an agent.');
      const base = { clientName: pending.clientName };
      const money = movesMoney(pending.authRequest);
      if (pending.signedIn && (!money || pending.ownerSession)) {
        return json({ ...base, ...consent(pending.signedIn, pending.authRequest) });
      }
      // Approving an allowance needs a fresh sign-in on this page.
      if (money) return json({ ...base, signedIn: false, spending: true });
      // Already signed in on this site: straight to the consent screen.
      const token = readSessionCookie(req);
      const who = token
        ? await verifySession(token, env.AGENT_CERT_SECRET).catch(() => null)
        : null;
      if (who) {
        await signIn.markSignedIn(id, who);
        return json({ ...base, ...consent(who, pending.authRequest) });
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
      return new Response(JSON.stringify(consent(who, request)), {
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
    // An agent that moves money keeps the owner signed in until they decide.
    const keep = async () => movesMoney((await signIn.load(id)).authRequest);
    if (path === '/api/connect/email/finish') {
      return signedIn(await signIn.finishEmail(id, str('code'), await keep()));
    }
    if (path === '/api/connect/google/start') {
      const url = await signIn.startGoogle(id, `${new URL(req.url).origin}/login`);
      return json({ url });
    }
    if (path === '/api/connect/google/finish') {
      return signedIn(await signIn.finishGoogle(id, str('callbackUrl'), await keep()));
    }
    if (path === '/api/connect/decide') {
      const pending = await signIn.load(id);
      if (!pending.authRequest)
        throw new ValidationError('This link is not for connecting an agent.');
      if (!pending.signedIn) throw new ValidationError('Sign in first.');
      const who = pending.signedIn;
      // Only the browser that signed in may decide: whoever started the request
      // knows its id, so the id alone would let them allow it for the owner.
      const owner = await sessionIdentity(req, env.AGENT_CERT_SECRET);
      if (!owner || owner.wallet !== who.wallet) {
        throw new AuthError('unauthorized', 'Sign in on this page to decide.');
      }
      if (body.allow !== true) {
        // Signs out first if the owner was kept signed in.
        if (pending.ownerSession) await signIn.withOwner(id, async () => {});
        else await signIn.forget(id);
        const back = new URL(pending.authRequest.redirectUri);
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('error_description', 'The owner did not allow access');
        if (pending.authRequest.state) back.searchParams.set('state', pending.authRequest.state);
        // The metadata says every response names the issuer (RFC 9207), errors too.
        back.searchParams.set('iss', new URL(req.url).origin);
        return json({ redirectTo: back.toString() });
      }
      // The profile is fixed for this connection's life.
      const authRequest = pending.authRequest;
      const profile = profileOf(authRequest);
      let keyId: string | undefined;
      let allowance: Awaited<ReturnType<typeof setUpAllowance>> | undefined;
      if (movesMoney(authRequest)) {
        const allowanceUsd = Number(body.allowanceUsd);
        const days = Number(body.days);
        const id_ = hexId();
        const key = agentKey(env.AGENT_KEYS!, id_);
        allowance = await signIn.withOwner(id, (oms) =>
          setUpAllowance({
            wallet: who.wallet,
            appName: pending.clientName ?? 'An agent',
            allowanceUsd,
            days,
            deps: {
              owner: oms.wallet,
              indexer: oms.indexer,
              prices: (tokens) => trailsPrices(env, tokens),
              key,
              now: () => new Date()
            }
          })
        );
        keyId = id_;
      } else {
        await signIn.forget(id);
      }
      const props: McpProps = {
        wallet: who.wallet,
        email: who.email,
        profile,
        ...(keyId ? { keyId, appName: pending.clientName ?? 'Your agent' } : {})
      };
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: authRequest,
        userId: who.wallet,
        metadata: {
          clientName: pending.clientName,
          email: who.email,
          profile,
          ...(keyId ? { keyId } : {}),
          ...(allowance
            ? { allowanceUsd: allowance.allowanceUsd, expiresAt: allowance.expiresAt }
            : {})
        },
        scope: authRequest.scope,
        props
      });
      return json({ redirectTo });
    }
    return fail(404, 'not_found', 'No such endpoint');
  } catch (err) {
    if (err instanceof AuthError) return fail(401, err.code, err.message);
    if (err instanceof ValidationError) return fail(400, 'invalid_request', err.message);
    if (err instanceof MoneyError) {
      if (err.code !== 'invalid_input') console.error('[connect]', err);
      return fail(err.code === 'invalid_input' ? 400 : 502, err.code, err.message);
    }
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
          const meta = (g.metadata ?? {}) as {
            clientName?: string;
            allowanceUsd?: number;
            expiresAt?: string;
          };
          agents.push({
            id: g.id,
            name: agentName(meta.clientName),
            connectedAt: g.createdAt,
            ...(meta.allowanceUsd !== undefined
              ? { allowanceUsd: meta.allowanceUsd, allowanceEndsAt: meta.expiresAt }
              : {})
          });
        }
        cursor = page.cursor;
      } while (cursor);
      agents.sort((a, b) => b.connectedAt - a.connectedAt);
      return json({ agents });
    }
    const m = /^\/api\/agents\/([^/]+)$/.exec(path);
    if (m && req.method === 'DELETE') {
      const grantId = decodeURIComponent(m[1]);
      // Its key goes too: revoked on OMS, so nothing it approved can be spent.
      const keyId = await grantKeyId(env.OAUTH_PROVIDER, owner.wallet, grantId);
      if (keyId && env.AGENT_KEYS) {
        await agentKey(
          env.AGENT_KEYS,
          keyId
        )({ op: 'revoke', wallet: owner.wallet }).catch((err) =>
          console.error('[agents] revoking key', err)
        );
      }
      await env.OAUTH_PROVIDER.revokeGrant(grantId, owner.wallet);
      return json({ disconnected: true });
    }
    return fail(404, 'not_found', 'No such endpoint');
  } catch (err) {
    if (err instanceof AuthError) return fail(401, err.code, err.message);
    console.error('[agents]', err);
    return fail(500, 'internal_error', 'Something went wrong');
  }
}

async function grantKeyId(
  provider: OAuthHelpers,
  wallet: string,
  grantId: string
): Promise<string | undefined> {
  let cursor: string | undefined;
  do {
    const page = await provider.listUserGrants(wallet, { cursor });
    const grant = page.items.find((g) => g.id === grantId);
    if (grant) return (grant.metadata as { keyId?: string } | undefined)?.keyId;
    cursor = page.cursor;
  } while (cursor);
  return undefined;
}

/**
 * An agent's request waiting for the owner (money/actions.ts): GET shows it,
 * POST {"approve"} answers it. Only the owner signed in on this site, and only
 * for a connection to their own wallet: the connection's key checks the wallet.
 */
export async function handleActionsApi(req: Request, env: Env, path: string): Promise<Response> {
  const signIn = ownerSignIn(env);
  if (!signIn || !env.AGENT_CERT_SECRET || !env.AGENT_KEYS) {
    return fail(503, 'mcp_unavailable', 'Connecting agents is not configured on this deployment');
  }
  const m =
    /^\/api\/actions\/([0-9a-f]{32})\/([0-9a-f]{24})(\/signin\/(email|google)\/(start|finish))?$/.exec(
      path
    );
  if (!m) return fail(404, 'not_found', 'No such request');
  const [, keyId, actionId, , method, step] = m;
  const key = agentKey(env.AGENT_KEYS, keyId);
  const answer = (res: Awaited<ReturnType<typeof key>>) => {
    if (res.ok) return json(res.value);
    // Another wallet's connection reads as not found, like a wrong id.
    if (res.error.code === 'not_connected') return fail(404, 'not_found', 'No such request');
    return fail(400, res.error.code, res.error.error);
  };
  try {
    // Signing in on the approval page: the worker's OMS sign-in, kept until the
    // owner answers (an owner action runs from their wallet), and the site's
    // session cookie, as on the connect page.
    if (method) {
      if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST');
      const body = (await readBody(req)) as Record<string, unknown>;
      const str = (k: string) => {
        const v = body[k];
        if (typeof v !== 'string' || !v.trim()) throw new ValidationError(`${k} is required`);
        return v.trim();
      };
      if (step === 'start') {
        const c = await signIn.create({});
        if (method === 'email') {
          await signIn.startEmail(c, str('email'));
          return json({ c });
        }
        return json({ c, url: await signIn.startGoogle(c, `${new URL(req.url).origin}/login`) });
      }
      const c = str('c');
      const who =
        method === 'email'
          ? await signIn.finishEmail(c, str('code'), true)
          : await signIn.finishGoogle(c, str('callbackUrl'), true);
      return new Response(JSON.stringify({ c, signedIn: true }), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Set-Cookie': sessionCookie(req, await issueSession(who, env.AGENT_CERT_SECRET))
        }
      });
    }

    const owner = await sessionIdentity(req, env.AGENT_CERT_SECRET);
    if (!owner) return fail(401, 'unauthorized', 'Sign in to answer this request');
    if (req.method === 'GET')
      return answer(await key({ op: 'action', wallet: owner.wallet, id: actionId }));
    if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use GET or POST');
    const body = (await readBody(req)) as { approve?: unknown; c?: unknown };
    const view = await key({ op: 'action', wallet: owner.wallet, id: actionId });
    if (!view.ok) return answer(view);
    const ownerAction = (view.value as { ownerSignIn?: boolean }).ownerSignIn === true;
    if (!ownerAction || body.approve !== true) {
      if (typeof body.c === 'string')
        await signIn.withOwner(body.c, async () => {}).catch(() => {});
      return answer(
        await key({
          op: 'decide',
          wallet: owner.wallet,
          id: actionId,
          approve: body.approve === true
        })
      );
    }
    // Runs from the owner's wallet, signed in on this page just now.
    if (typeof body.c !== 'string')
      throw new ValidationError('Sign in on this page to approve it.');
    const pending = await signIn.load(body.c);
    if (!pending.ownerSession || pending.signedIn?.wallet !== owner.wallet) {
      throw new ValidationError('Sign in on this page to approve it.');
    }
    return answer(
      await signIn.withOwner(body.c, async (oms) => {
        const begun = await key({ op: 'owner_begin', wallet: owner.wallet, id: actionId });
        if (!begun.ok) return begun;
        const txs = begun.value as {
          chainId: number;
          transactions: { to: string; data: string }[];
        };
        try {
          const result = await runAsOwner({ oms, wallet: owner.wallet, ...txs });
          return key({ op: 'owner_end', wallet: owner.wallet, id: actionId, result });
        } catch (err) {
          console.error('[actions] owner run', err);
          const e =
            err instanceof MoneyError
              ? err.toJSON()
              : {
                  error: err instanceof Error ? err.message : 'It failed.',
                  code: 'upstream_error' as const
                };
          return key({ op: 'owner_end', wallet: owner.wallet, id: actionId, error: e });
        }
      })
    );
  } catch (err) {
    if (err instanceof AuthError) return fail(401, err.code, err.message);
    if (err instanceof ValidationError) return fail(400, 'invalid_request', err.message);
    console.error('[actions]', err);
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
    const finish = async (id: string, who: { wallet: string; email: string | null }) => {
      await signIn.forget(id);
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

/** GET /.well-known/openai-apps-challenge: OpenAI's check that we own this domain. */
export function openaiChallenge(env: Env): Response {
  return env.OPENAI_APPS_CHALLENGE
    ? new Response(env.OPENAI_APPS_CHALLENGE, { headers: { 'Content-Type': 'text/plain' } })
    : new Response('Not found', { status: 404 });
}

/** GET /authorize: an MCP client wants access. Hand off to the connect page. */
async function handleAuthorize(req: Request, env: Env): Promise<Response> {
  const signIn = ownerSignIn(env);
  if (!signIn || !env.OAUTH_PROVIDER) {
    return new Response('Connecting agents is not configured on this deployment', { status: 503 });
  }
  let authRequest;
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(req);
  } catch (err) {
    // A request we can answer: back to the client when its redirect is known.
    if (err instanceof AuthorizationError) {
      return err.redirectTo
        ? Response.redirect(err.redirectTo, 302)
        : new Response(err.description ?? 'Invalid authorization request', { status: 400 });
    }
    throw err;
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  if (!client) return new Response('Unknown client', { status: 400 });
  const id = await signIn.create({ authRequest, clientName: agentName(client.clientName) });
  return Response.redirect(`${new URL(req.url).origin}/connect?c=${id}`, 302);
}

// The site: the SPA (with SPA fallback), the sign-in API, and the MCP
// connect flow. The OAuth provider sits in front of it for /mcp.
const app = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/authorize') return handleAuthorize(request, env);
    if (url.pathname === '/.well-known/openai-apps-challenge') return openaiChallenge(env);
    // The OAuth provider answers its own metadata; anything else here is not ours.
    if (url.pathname.startsWith('/.well-known/')) return new Response('Not found', { status: 404 });
    if (url.pathname.startsWith('/api/connect'))
      return handleConnectApi(request, env, url.pathname);
    if (url.pathname.startsWith('/api/actions/'))
      return handleActionsApi(request, env, url.pathname);
    if (url.pathname === '/api/agents' || url.pathname.startsWith('/api/agents/'))
      return handleAgentsApi(request, env, url.pathname);
    if (url.pathname === '/api/session' || url.pathname.startsWith('/api/session/'))
      return handleSessionApi(request, env, url.pathname);
    if (url.pathname.startsWith('/api/')) return fail(404, 'not_found', 'No such endpoint');

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
        resource_name: 'Open Money Agent'
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

// Cloudflare Workers require a default export. Without the OAuth store the
// site still runs; /mcp answers 404.
// eslint-disable-next-line import-x/no-default-export
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.OAUTH_KV) return app.fetch(request, env);
    const limited = await limitRegistration(request, env);
    if (limited) return limited;
    // A copy of env per request: the provider keeps its helpers on env.OAUTH_PROVIDER
    // and only sets them when missing, so on a shared env the first site served would
    // answer for the other one too (checking its own /mcp as the resource).
    const { OAUTH_PROVIDER: _shared, ...own } = env;
    return oauthFor(new URL(request.url).origin).fetch(request, own, ctx);
  }
};

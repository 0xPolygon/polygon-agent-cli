// agentconnect worker: the SPA (with SPA fallback) plus the credentials API
// that agents and the dashboard use to save and read a shipping address.

import type { AgentIdentity, OmsIdTokenConfig } from './agent-auth.ts';

import { AuthError, issueCertificate, verifyAccessToken, verifyEnrollToken } from './agent-auth.ts';
import { OmsCustomers, OmsError } from './oms-customers.ts';
import {
  addressFromMetadata,
  addressToMetadata,
  parseAddress,
  ValidationError
} from './shipping.ts';

export interface Env {
  ASSETS: Fetcher;
  // Vars (wrangler.toml)
  OMS_API_URL?: string;
  OMS_ID_TOKEN_ISSUER?: string;
  OMS_ID_TOKEN_AUDIENCES?: string;
  OMS_JWKS_URL?: string;
  // Secrets (wrangler secret put)
  OMS_API_KEY?: string;
  OMS_API_SECRET?: string;
  AGENT_CERT_SECRET?: string;
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

function customers(env: Env): OmsCustomers | null {
  if (!env.OMS_API_URL || !env.OMS_API_KEY || !env.OMS_API_SECRET) return null;
  return new OmsCustomers({
    apiUrl: env.OMS_API_URL,
    apiKey: env.OMS_API_KEY,
    apiSecret: env.OMS_API_SECRET
  });
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
      const oms = customers(env);
      if (!oms) return fail(503, 'credentials_unavailable', 'Address storage is not configured');

      if (req.method === 'GET') {
        const c = await oms.findByWallet(who.wallet);
        return json({ address: addressFromMetadata(c?.metadata) });
      }
      if (req.method === 'PUT') {
        const address = parseAddress(await readBody(req));
        const c = await oms.upsertMetadata(who.wallet, who.email, addressToMetadata(address));
        return json({ address: addressFromMetadata(c.metadata) ?? address });
      }
      if (req.method === 'DELETE') {
        const c = await oms.findByWallet(who.wallet);
        if (c)
          await oms.updateMetadata(c.id, { ...(c.metadata ?? {}), ...addressToMetadata(null) });
        return json({ address: null });
      }
      return fail(405, 'method_not_allowed', 'Use GET, PUT, or DELETE');
    }

    return fail(404, 'not_found', 'No such endpoint');
  } catch (err) {
    if (err instanceof AuthError) {
      return fail(401, err.code, err.message);
    }
    if (err instanceof ValidationError) return fail(400, 'invalid_request', err.message);
    if (err instanceof OmsError) {
      console.error('[oms]', err.status, err.code, err.message);
      return fail(502, 'upstream_error', 'The address service is unavailable. Try again shortly.');
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

import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { baseUrl, shouldRun, smokeFetch } from './smoke.ts';

const UnauthorizedSchema = z.object({ error: z.literal('unauthorized') });

describe.skipIf(!shouldRun)('agentconnect prod smoke', () => {
  const origin = baseUrl === undefined ? '' : new URL(baseUrl).origin;

  it('GET / serves the SPA', async () => {
    const res = await smokeFetch('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('GET /skill.md serves the skill as markdown', async () => {
    const res = await smokeFetch('/skill.md');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
  });

  it('GET /api/session is 401 when signed out', async () => {
    const res = await smokeFetch('/api/session');
    expect(res.status).toBe(401);
    UnauthorizedSchema.parse(await res.json(), { reportInput: true });
  });

  it('serves OAuth authorization-server metadata for its own origin', async () => {
    const res = await smokeFetch('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const body = z.object({ issuer: z.string() }).parse(await res.json(), { reportInput: true });
    expect(body.issuer).toBe(origin);
  });

  // The OAuth provider serves protected-resource metadata at the path-suffixed URL (RFC 9728),
  // which is what the /mcp 401 challenge points clients at; the bare path is a 404.
  it('serves protected-resource metadata for /mcp', async () => {
    const res = await smokeFetch('/.well-known/oauth-protected-resource/mcp');
    expect(res.status).toBe(200);
    const body = z.object({ resource: z.string() }).parse(await res.json(), { reportInput: true });
    expect(body.resource).toBe(`${origin}/mcp`);
  });

  it('rejects an unauthenticated POST /mcp with 401', async () => {
    const res = await smokeFetch('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    expect(res.status).toBe(401);
  });
});

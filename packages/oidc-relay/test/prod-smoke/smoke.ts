export const baseUrl = process.env['SMOKE_BASE_URL'];

/** True only when a target is set, so the suite skips instead of failing without one. */
export const shouldRun = Boolean(baseUrl);

/** GET/POST against the deployed instance; Cloudflare drops requests without a User-Agent. */
export async function smokeFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (baseUrl === undefined) throw new Error('SMOKE_BASE_URL is not set');
  if (!baseUrl.startsWith('https://')) throw new Error('SMOKE_BASE_URL must use HTTPS');
  return fetch(new URL(path, baseUrl), {
    ...init,
    redirect: 'manual',
    headers: { 'User-Agent': 'oidc-relay-prod-smoke/1.0', ...init.headers }
  });
}

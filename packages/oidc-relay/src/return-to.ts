// Host allowlist for the post-capture redirect. Prevents the OIDC callback
// from being turned into an open redirect: only our login pages (plus
// localhost for dev) may be a returnTo target.

const ALLOWED_HOSTS = new Set([
  'agentconnect.polygon.technology',
  'agentconnect.staging.polygon.technology',
  'localhost',
  '127.0.0.1'
]);

export function validReturnTo(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) return false;
  return ALLOWED_HOSTS.has(url.hostname);
}

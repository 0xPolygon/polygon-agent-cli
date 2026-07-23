// Pure helpers for detecting the login page's session id and whether the
// load is a bounce back from the OMS relay. Kept free of `window` so they can
// be unit tested directly; the component passes in `location.search` and
// `location.hash`.
//
// Two distinct url shapes land on this page:
// - CLI announce: `/login#<session>` (fragment). The CLI opens this in the
//   user's browser with nothing to lose by putting the session in the
//   fragment, since there is no round trip through a third party.
// - Relay return: `/login?<oms params>` (query only, e.g. `code`, `state`).
//   The return URI registered with the OMS relay must be the bare, static
//   `/login` to satisfy its allowlist (an exact-string match), so it can no
//   longer carry `?s=`. The pairing session is instead stashed in
//   sessionStorage by the component before the redirect to Google, and
//   recovered from there when the browser bounces back; these helpers only
//   see the query/fragment, not sessionStorage.

// Session id lives in the `?s=` query param (used for the legacy relay
// return shape, and still supported); the `#` fragment is the primary
// carrier for the CLI announce link. On an OMS relay return neither is
// present, since the return URI is now the bare, static `/login` — the
// component falls back to sessionStorage in that case.
export function getSessionId(search: string, hash: string): string {
  const fromQuery = new URLSearchParams(search).get('s');
  if (fromQuery) return fromQuery;
  return hash.slice(1);
}

// The OAuth callback params the OMS relay appends to the return URL once
// Google sign-in bounces back through it. The SDK consumes these directly
// from the query string, so their presence is what actually distinguishes a
// relay return from a fresh open.
const OAUTH_CALLBACK_PARAMS = ['code', 'state', 'error'];

// True when this load is the browser bouncing back from the OMS relay after
// Google sign-in, not a fresh open. We key specifically on the OAuth callback
// params (`code`, `state`, `error`) the relay appends to the static `/login`
// return URI, rather than on "any other query key present": a link wrapper or
// ad click can append tracking params (`utm_*`, `gclid`, etc.) to a pasted
// `/login?...` link, and that must not be mistaken for a relay return that
// posts a bogus callback to the relay. This no longer requires `s` alongside
// them, since the return URI is static and never carries it.
export function isRelayReturn(search: string): boolean {
  const params = new URLSearchParams(search);
  return OAUTH_CALLBACK_PARAMS.some((key) => params.has(key));
}

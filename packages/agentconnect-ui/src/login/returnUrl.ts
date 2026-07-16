// Pure helpers for detecting the login page's session id and whether the
// load is a bounce back from the OMS relay. Kept free of `window` so they can
// be unit tested directly; the component passes in `location.search` and
// `location.hash`.
//
// Two distinct url shapes land on this page:
// - CLI announce: `/login#<session>` (fragment). The CLI opens this in the
//   user's browser with nothing to lose by putting the session in the
//   fragment, since there is no round trip through a third party.
// - Relay return: `/login?s=<session>&<oms params>` (query). Once Google
//   sign-in bounces through the OMS relay and back, the session has to
//   survive as a query param, since a fragment is never sent to (or
//   preserved by) a server in the middle of that redirect chain, and the
//   relay appends its own callback params (code, state, etc.) alongside it.

// Session id lives in the `?s=` query param (used for the OMS relay return
// URI, since fragments may be consumed by the relay); the `#` fragment is
// kept as a fallback for older announce links.
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
// params (`code`, `state`, `error`) the relay appends alongside `s`, rather
// than on "any other query key present": a link wrapper or ad click can
// append tracking params (`utm_*`, `gclid`, etc.) to a pasted `/login?s=...`
// link, and that must not be mistaken for a relay return that posts a bogus
// callback to the relay.
export function isRelayReturn(search: string): boolean {
  const params = new URLSearchParams(search);
  if (!params.get('s')) return false;
  return OAUTH_CALLBACK_PARAMS.some((key) => params.has(key));
}

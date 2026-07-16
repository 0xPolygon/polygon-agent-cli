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

// True when this load is the browser bouncing back from the OMS relay after
// Google sign-in, not a fresh open. The CLI's announce URL is a bare
// `/login#<session>` fragment with no query string at all, so any query key
// besides `s` showing up alongside it means the OMS relay appended its own
// callback params on the way back.
export function isRelayReturn(search: string): boolean {
  const params = new URLSearchParams(search);
  if (!params.get('s')) return false;
  for (const key of params.keys()) {
    if (key !== 's') return true;
  }
  return false;
}

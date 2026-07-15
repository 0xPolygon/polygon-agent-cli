// Client for the public OIDC handoff relay (packages/oidc-relay), used by the
// `wallet login-browser --remote` path. When the CLI runs on a machine whose
// localhost the browser can't reach (a remote server / openclaw), we can't use a
// loopback callback. Instead we register a handoff keyed by the OIDC `state`, the
// browser is redirected to the relay's public callback, and the CLI polls for the
// captured `code`+`state`.
//
// The relay only ever sees `code`+`state`; the PKCE verifier and wallet credential
// never leave this process, so the relay alone cannot complete a login.

interface RelayCallback {
  code: string;
  state: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Arm a handoff for this OIDC `state` so the relay tracks it (and /poll returns
 * `pending` until the browser callback lands). Call right after startOidcRedirectAuth.
 */
export async function registerRelaySession(
  relayBase: string,
  state: string,
  returnTo?: string
): Promise<void> {
  const res = await fetch(`${relayBase}/api/oidc/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(returnTo ? { state, returnTo } : { state })
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(
      `Relay register failed (${res.status}). Check POLYGON_AGENT_OIDC_RELAY / --relay-url.`
    );
  }
}

/**
 * Poll the relay until the browser callback arrives, then return the `code`+`state`.
 * Throws on provider error, an expired/unknown session, or timeout.
 */
export async function pollRelayForCallback(
  relayBase: string,
  state: string,
  opts: { timeoutMs: number; intervalMs?: number }
): Promise<RelayCallback> {
  // Poll briskly: this runs after the browser has returned from the provider,
  // so the captured code is usually already waiting and a tight interval keeps
  // the "finishing sign in" screen short.
  const intervalMs = opts.intervalMs ?? 800;
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${relayBase}/api/oidc/poll?state=${encodeURIComponent(state)}`);
    if (!res.ok) throw new Error(`Relay poll failed (${res.status})`);
    const data = (await res.json()) as {
      status: string;
      code?: string;
      state?: string;
      error?: string;
    };
    if (data.status === 'ready') {
      if (!data.code || !data.state) throw new Error('Relay returned "ready" without code/state');
      return { code: data.code, state: data.state };
    }
    if (data.status === 'error') throw new Error(data.error || 'Login failed at the provider');
    if (data.status === 'expired') throw new Error('Relay session expired before login completed');
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for browser login. Re-run, or use `wallet login`.');
}

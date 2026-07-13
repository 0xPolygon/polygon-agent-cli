// HTTP client for the relay's /api/login pairing routes (packages/oidc-relay).
// Produces the `relay` dependency for runBrowserLogin; the OIDC handoff pieces
// reuse the existing oidc-relay-client functions.

import type { BrowserLoginDeps, LoginAction, LoginStatus } from './browser-login.ts';

import { pollRelayForCallback, registerRelaySession } from './oidc-relay-client.ts';

export function makeLoginRelay(relayBase: string): BrowserLoginDeps['relay'] {
  return {
    async registerSession(session: string): Promise<void> {
      const res = await fetch(`${relayBase}/api/login/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session })
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(
          `Relay register failed (${res.status}). Check POLYGON_AGENT_OIDC_RELAY / --relay-url, or use --local.`
        );
      }
    },

    async nextAction(session: string): Promise<LoginAction | null> {
      const res = await fetch(
        `${relayBase}/api/login/next-action?session=${encodeURIComponent(session)}`
      );
      if (!res.ok) throw new Error(`Relay poll failed (${res.status})`);
      const data = (await res.json()) as { state: string; action?: LoginAction };
      if (data.state === 'expired') {
        throw new Error('Login session expired before completion. Re-run `wallet login`.');
      }
      return data.state === 'action' && data.action ? data.action : null;
    },

    async setStatus(session: string, status: LoginStatus): Promise<void> {
      const res = await fetch(`${relayBase}/api/login/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session, status })
      });
      if (!res.ok && res.status !== 204)
        throw new Error(`Relay status update failed (${res.status})`);
    },

    registerOidcHandoff(state: string, returnTo: string): Promise<void> {
      return registerRelaySession(relayBase, state, returnTo);
    },

    pollOidcCallback(state: string, timeoutMs: number): Promise<{ code: string; state: string }> {
      return pollRelayForCallback(relayBase, state, { timeoutMs });
    }
  };
}

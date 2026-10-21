// What the HTTP API and the MCP server both use for a wallet: its saved details.

import type { Env } from './index.ts';

import { CredentialStore } from './store.ts';

export function store(env: Env): CredentialStore | null {
  if (!env.CREDENTIALS || !env.CREDENTIALS_KEY) return null;
  return new CredentialStore(env.CREDENTIALS, env.CREDENTIALS_KEY);
}

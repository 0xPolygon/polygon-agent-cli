// Saved credentials, read and written as the owner signed in on this site
// (a session cookie), or with the access token the agent put in the dashboard
// link's fragment (#t=...). The fragment never reaches a server; we move it to
// sessionStorage and clear it from the address bar.

import { rememberedEmail, rememberEmail } from './account.js';

const STORAGE_KEY = 'agentconnect.token';

export interface ShippingAddress {
  name: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone: string;
}

export const EMPTY_ADDRESS: ShippingAddress = {
  name: '',
  line1: '',
  line2: '',
  city: '',
  state: '',
  zip: '',
  country: '',
  phone: ''
};

function tokenClaims(token: string): { w?: string; exp?: number } | null {
  try {
    const payload = token.split('.')[3];
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

/**
 * The owner's email, from the certificate inside the agent's link token. It is
 * remembered per wallet so the sidebar keeps it after the token expires.
 */
export function accountEmail(wallet: string, token: string | null): string | null {
  try {
    const cert = token?.split('.')[1];
    const email = cert
      ? (JSON.parse(atob(cert.replace(/-/g, '+').replace(/_/g, '/'))) as { e?: string }).e
      : undefined;
    rememberEmail(wallet, email);
  } catch {
    // An unreadable token: fall back to what this browser remembers.
  }
  return rememberedEmail(wallet);
}

/** Take the token from the URL fragment (once), else from this tab's storage. */
export function takeLinkToken(wallet: string): string | null {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const fromHash = hash.get('t');
  if (fromHash) {
    try {
      sessionStorage.setItem(STORAGE_KEY, fromHash);
    } catch {
      // Private mode: the token still works until the page closes.
    }
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  let token = fromHash;
  if (!token) {
    try {
      token = sessionStorage.getItem(STORAGE_KEY);
    } catch {
      token = null;
    }
  }
  if (!token) return null;
  // Only for this wallet, and only while it lasts.
  const claims = tokenClaims(token);
  if (!claims || claims.w !== wallet.toLowerCase()) return null;
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return null;
  return token;
}

// Stands in for a token when the owner is signed in here: the cookie goes along.
export const SESSION_AUTH = 'session';

export class CredentialsError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

async function call<T>(
  token: string,
  method: string,
  body?: unknown,
  path = '/api/credentials/address'
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      ...(token === SESSION_AUTH ? {} : { Authorization: `Agent ${token}` }),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok)
    throw new CredentialsError(res.status, data.message ?? `Request failed (${res.status})`);
  return data;
}

export const getAddress = (token: string) =>
  call<{ address: ShippingAddress | null }>(token, 'GET').then((r) => r.address);

export const saveAddress = (token: string, address: ShippingAddress) =>
  call<{ address: ShippingAddress }>(token, 'PUT', address).then((r) => r.address);

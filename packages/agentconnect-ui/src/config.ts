import { getEnv } from './env';

// Configured via VITE_* secrets (per-environment values set in GitHub Environments).

// Trails widget API key (used by the Fund onramp widget).
export const trailsApiKey = getEnv().VITE_TRAILS_API_KEY ?? '';

// oidc-relay base URL for the /login pairing session (per-environment GitHub
// variable). CI passes the var unconditionally, so an unset variable arrives
// as an empty string; the schema falls back to the production default.
export const oidcRelayUrl = getEnv().VITE_OIDC_RELAY_URL;

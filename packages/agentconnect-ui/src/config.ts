// Configured via VITE_* secrets (per-environment values set in GitHub Environments).

// Trails widget API key (used by the Fund onramp widget).
export const trailsApiKey = (import.meta.env.VITE_TRAILS_API_KEY as string | undefined) ?? '';

// oidc-relay base URL for the /login pairing session (per-environment secret).
export const oidcRelayUrl =
  (import.meta.env.VITE_OIDC_RELAY_URL as string | undefined) ??
  'https://oidc-relay.polygon.technology';

// Configured via VITE_* secrets (per-environment values set in GitHub Environments).

// Trails widget API key (used by the Fund onramp widget).
export const trailsApiKey = (import.meta.env.VITE_TRAILS_API_KEY as string | undefined) ?? '';

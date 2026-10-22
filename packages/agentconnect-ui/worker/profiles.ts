// What each MCP client may do. A connection gets its profile when the owner
// allows it, from the OAuth client it came from, and keeps it for its life.
//
// `standard` is every client we haven't set up. A platform with stricter rules
// (Muse takes no money movement) gets a client we register for it, mapped here
// by client id.

export type Profile = 'standard' | 'muse';

export interface ProfilePolicy {
  // Tools the client sees and may call. An allowlist: a new tool reaches a
  // restricted client only when someone adds it here.
  tools: readonly string[];
}

const COMMON = ['get_wallet'] as const;

export const PROFILES: Record<Profile, ProfilePolicy> = {
  standard: { tools: [...COMMON] },
  muse: { tools: [...COMMON] }
};

const isProfile = (v: unknown): v is Profile => typeof v === 'string' && Object.hasOwn(PROFILES, v);

/**
 * The profile for an OAuth client, from MCP_CLIENT_PROFILES (JSON, client id to
 * profile). Keyed by client id, never by the name a client registers with,
 * since anyone can register under any name.
 */
export function profileForClient(config: string | undefined, clientId: string): Profile {
  if (!config) return 'standard';
  try {
    const map = JSON.parse(config) as Record<string, unknown>;
    const profile = Object.hasOwn(map, clientId) ? map[clientId] : undefined;
    return isProfile(profile) ? profile : 'standard';
  } catch {
    console.error('[profiles] MCP_CLIENT_PROFILES is not valid JSON');
    return 'standard';
  }
}

/** A connection's policy. Connections made before profiles existed are standard. */
export const policyOf = (profile: unknown): ProfilePolicy =>
  PROFILES[isProfile(profile) ? profile : 'standard'];

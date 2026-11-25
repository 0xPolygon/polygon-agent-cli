import type { Address } from 'viem';

// Checksummed. Consumers that compare against lowercased addresses lowercase this first.
export const USDC_POLYGON: Address = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

// The Trails RPC base; callers append the method (`${TRAILS_API_URL}/GetTokenList`).
export const TRAILS_API_URL = 'https://trails-api.sequence.app/rpc/Trails';

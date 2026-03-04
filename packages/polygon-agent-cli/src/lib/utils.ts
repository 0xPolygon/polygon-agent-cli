import fs from 'node:fs';

import type { ChainId, NetworkMetadata } from '@0xsequence/network';
// eslint-disable-next-line perfectionist/sort-imports -- type + value import from same module
import { networks } from '@0xsequence/network';

/** Read a CLI arg value, supporting @filename coercion */
export function fileCoerce(val: string): string {
  if (typeof val === 'string' && val.startsWith('@')) {
    const filePath = val.slice(1);
    try {
      return fs.readFileSync(filePath, 'utf8').trim();
    } catch (err) {
      throw new Error(`Failed to read file ${filePath}: ${(err as Error).message}`);
    }
  }
  return val;
}

/** Normalize chain name (back-compat helper) */
export function normalizeChain(raw: string | undefined): string {
  const c = String(raw || '').toLowerCase();
  if (!c) return 'polygon';
  if (c === 'matic') return 'polygon';
  return c;
}

/** Resolve network from chain name or ID */
export function resolveNetwork(chainOrId: string | number): NetworkMetadata {
  const chainId = parseInt(String(chainOrId));
  if (!isNaN(chainId)) {
    const network = networks[chainId as ChainId];
    if (network) return network;
  }

  const lowerName = String(chainOrId).toLowerCase();
  for (const network of Object.values(networks)) {
    if (network.name.toLowerCase() === lowerName) {
      return network;
    }
  }

  throw new Error(`Unknown chain: ${chainOrId}`);
}

/** Format units (wei to human-readable) */
export function formatUnits(value: bigint | string, decimals = 18): string {
  const bigValue = BigInt(value);
  const divisor = BigInt(10) ** BigInt(decimals);

  const intPart = bigValue / divisor;
  const fracPart = bigValue % divisor;

  if (fracPart === 0n) {
    return intPart.toString();
  }

  const fracStr = fracPart.toString().padStart(decimals, '0');
  const trimmed = fracStr.replace(/0+$/, '');

  return `${intPart}.${trimmed}`;
}

/** Parse units (human-readable to wei) */
export function parseUnits(value: string, decimals = 18): bigint {
  const [intPart, fracPart = ''] = value.split('.');

  const paddedFrac = fracPart.padEnd(decimals, '0').slice(0, decimals);
  const combined = intPart + paddedFrac;

  return BigInt(combined);
}

/** Get indexer URL for chain (learned from upstream fix) */
export function getIndexerUrl(): string {
  return (
    process.env.SEQUENCE_INDEXER_URL ||
    'https://indexer.sequence.app/rpc/IndexerGateway/GetTokenBalancesSummary'
  );
}

/** Get RPC URL for a network via Sequence nodes */
export function getRpcUrl(network: NetworkMetadata): string {
  const accessKey = process.env.SEQUENCE_PROJECT_ACCESS_KEY || '';
  return `https://nodes.sequence.app/${network.name}/${accessKey}`;
}

/** Explorer URL for transaction */
export function getExplorerUrl(network: NetworkMetadata, txHash: string): string {
  const base = network.blockExplorer?.rootUrl || `https://polygonscan.com`;
  return `${base}/tx/${txHash}`;
}

/** Generate random hex string */
export function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Generate a unique agent name: polygon-agent-<adjective>-<noun> */
export function generateAgentName(): string {
  const adjectives = [
    'brave',
    'calm',
    'dark',
    'epic',
    'fast',
    'gold',
    'jade',
    'keen',
    'lone',
    'mild',
    'neat',
    'odd',
    'pale',
    'quick',
    'red',
    'sage',
    'tall',
    'ultra',
    'vast',
    'wild',
    'zany',
    'amber',
    'bold',
    'cool',
    'deep',
    'eager',
    'fair',
    'gray',
    'hollow',
    'iron',
    'jolly',
    'kind'
  ];
  const nouns = [
    'atlas',
    'bolt',
    'comet',
    'dune',
    'echo',
    'flame',
    'grove',
    'hawk',
    'inlet',
    'jade',
    'kite',
    'lance',
    'mesa',
    'node',
    'orbit',
    'peak',
    'quasar',
    'ridge',
    'storm',
    'tide',
    'umber',
    'vale',
    'wave',
    'xenon',
    'yak',
    'zenith',
    'arc',
    'bay',
    'cliff',
    'drift',
    'ember',
    'frost'
  ];
  const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
  return `polygon-agent-${pick(adjectives)}-${pick(nouns)}`;
}

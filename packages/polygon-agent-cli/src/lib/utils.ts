import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ChainId, NetworkMetadata } from '@0xsequence/network';
// eslint-disable-next-line perfectionist/sort-imports -- type + value import from same module
import { networks } from '@0xsequence/network';

import { STORAGE_ROOT } from './storage.ts';

// The folders holding wallet keys: this install's state, and a global
// install's. Their files are never read into an argument (an injected
// assistant could otherwise post them anywhere with x402-pay --body @file).
// Folders are compared by device and inode, not by name, so a different
// spelling (a case-insensitive filesystem, a symlinked folder) can't slip by.
function inStateFolder(file: string): boolean {
  const id = (p: string) => {
    try {
      const stat = fs.statSync(p);
      return `${stat.dev}:${stat.ino}`;
    } catch {
      return null;
    }
  };
  const stateIds = new Set(
    [STORAGE_ROOT, path.join(os.homedir(), '.polygon-agent')].map(id).filter((v) => v !== null)
  );
  let target: string;
  try {
    target = fs.realpathSync(file);
  } catch {
    target = path.resolve(file);
  }
  for (let dir = path.dirname(target); ; dir = path.dirname(dir)) {
    const dirId = id(dir);
    if (dirId !== null && stateIds.has(dirId)) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

/** Read a CLI arg value, supporting @filename coercion */
export function fileCoerce(val: string): string {
  if (typeof val === 'string' && val.startsWith('@')) {
    const filePath = val.slice(1);
    if (inStateFolder(filePath)) {
      throw new Error(`Refusing to read ${filePath}: it's in the CLI's state folder.`);
    }
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

/** Get RPC URL for a network via OMS nodes */
export function getRpcUrl(network: NetworkMetadata): string {
  const accessKey = process.env.SEQUENCE_PROJECT_ACCESS_KEY || '';
  return `https://nodes.sequence.app/${network.name}/${accessKey}`;
}

// Public RPC fallbacks per chain — used for read-only calls (e.g. tx receipt
// polling) when no OMS project access key is available (the OMS path uses
// publishableKey/projectId, not a nodes.sequence.app access key).
const PUBLIC_RPC_BY_CHAIN_ID: Record<number, string> = {
  137: 'https://polygon-rpc.com',
  80002: 'https://rpc-amoy.polygon.technology',
  8453: 'https://mainnet.base.org',
  84532: 'https://sepolia.base.org',
  1: 'https://eth.llamarpc.com',
  42161: 'https://arb1.arbitrum.io/rpc',
  10: 'https://mainnet.optimism.io'
};

/**
 * Read-only RPC URL. Prefers the OMS nodes endpoint when a project access
 * key is configured; otherwise falls back to a public RPC for the chain.
 */
export function getReadRpcUrl(network: NetworkMetadata): string {
  const accessKey = process.env.SEQUENCE_PROJECT_ACCESS_KEY;
  if (accessKey) return `https://nodes.sequence.app/${network.name}/${accessKey}`;
  return PUBLIC_RPC_BY_CHAIN_ID[network.chainId] || `https://polygon-rpc.com`;
}

/** Explorer URL for transaction */
export function getExplorerUrl(network: NetworkMetadata, txHash: string): string {
  const raw = network.blockExplorer?.rootUrl || `https://polygonscan.com`;
  const base = raw.replace(/\/+$/, '');
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

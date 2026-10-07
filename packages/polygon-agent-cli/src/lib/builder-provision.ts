// Post-login Builder provisioning: gives every agent its own Sequence Builder
// project + access key (indexer and Trails quota) with zero manual steps.
// Signs an ETHAuth proof with an ephemeral EOA, exactly like `setup` always
// did, but runs automatically after `wallet login`. Best-effort by contract:
// this function never throws; a failure must never fail a completed login.

import path from 'node:path';

import { ethers } from 'ethers';

import { getAuthToken, createProject, getDefaultAccessKey } from './builder-api.ts';
import { CliError } from './errors.ts';
import { generateEthAuthProof } from './ethauth.ts';
import { LockHeldError, withLock } from './lock.ts';
import { loadBuilderConfigRaw, saveBuilderConfig, STORAGE_ROOT } from './storage.ts';

/** Normalize any thrown value to a message string, even for non-Error throws. */
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface ProvisionDeps {
  loadBuilderConfig(): Promise<{ accessKey?: string } | null>;
  saveBuilderConfig(cfg: {
    privateKey: string;
    eoaAddress: string;
    accessKey: string;
    projectId: number;
  }): Promise<void>;
  createEoa(): { privateKey: string; address: string };
  generateProof(privateKey: string): Promise<string>;
  getAuthToken(proof: string): Promise<string>;
  createProject(name: string, jwt: string): Promise<{ id: number; name: string }>;
  getDefaultAccessKey(projectId: number, jwt: string): Promise<string>;
}

export interface ProvisionResult {
  provisioned: boolean;
  reason?: string;
}

export function makeDefaultProvisionDeps(): ProvisionDeps {
  return {
    loadBuilderConfig: async () => loadBuilderConfigRaw(),
    saveBuilderConfig,
    createEoa: () => {
      const wallet = ethers.Wallet.createRandom();
      return { privateKey: wallet.privateKey, address: wallet.address };
    },
    generateProof: (privateKey) => generateEthAuthProof(privateKey),
    getAuthToken,
    createProject,
    getDefaultAccessKey
  };
}

/** Provision a Builder project + access key unless one already exists. Never throws. */
export async function ensureBuilderAccessKey(
  walletAddress: string,
  deps: ProvisionDeps
): Promise<ProvisionResult> {
  try {
    const existing = await deps.loadBuilderConfig();
    if (existing?.accessKey) return { provisioned: false, reason: 'existing' };
  } catch {
    // An unreadable config is treated as absent; provisioning may repair it.
  }

  let eoa: { privateKey: string; address: string };
  try {
    eoa = deps.createEoa();
  } catch (error) {
    return { provisioned: false, reason: `eoa: ${msg(error)}` };
  }

  let jwt: string;
  try {
    const proof = await deps.generateProof(eoa.privateKey);
    jwt = await deps.getAuthToken(proof);
  } catch (error) {
    return { provisioned: false, reason: `auth: ${msg(error)}` };
  }

  const projectName = `polygon-agent-${walletAddress.slice(2, 10).toLowerCase()}`;

  let projectId: number;
  try {
    const project = await deps.createProject(projectName, jwt);
    projectId = project.id;
  } catch (error) {
    return { provisioned: false, reason: `project: ${msg(error)}` };
  }

  try {
    const accessKey = await deps.getDefaultAccessKey(projectId, jwt);
    await deps.saveBuilderConfig({
      privateKey: eoa.privateKey,
      eoaAddress: eoa.address,
      accessKey,
      projectId
    });
    return { provisioned: true };
  } catch (error) {
    return { provisioned: false, reason: `access-key: ${msg(error)}` };
  }
}

// Provisioning, one process at a time: two first uses could otherwise each
// create a signer and overwrite the other's saved key, after one of them may
// already have funded its signer. The config is re-checked under the lock.
export async function provisionBuilderOnce(params: {
  walletAddress: string;
  deps?: ProvisionDeps;
}): Promise<ProvisionResult> {
  try {
    return await withLock({
      dir: path.join(STORAGE_ROOT, 'locks', 'builder.lock'),
      waitMs: 120_000,
      fn: () =>
        ensureBuilderAccessKey(params.walletAddress, params.deps ?? makeDefaultProvisionDeps())
    });
  } catch (error) {
    if (error instanceof LockHeldError) {
      throw new CliError({
        code: 'wallet_busy',
        message:
          "Another polygon-agent command is setting up this install's Builder access. Try again shortly.",
        cause: error
      });
    }
    throw error;
  }
}

// This install's Builder access key (Trails quotes, indexer quota) and signer
// EOA (x402), set up on first use if missing: session-mode installs connect by
// email code and never ran the browser login that provisions them.
export async function ensureBuilderAccess(walletAddress: string): Promise<void> {
  if (loadBuilderConfigRaw()?.accessKey) return;
  const result = await provisionBuilderOnce({ walletAddress });
  if (!result.provisioned && result.reason !== 'existing') {
    throw new CliError({
      code: 'upstream_unavailable',
      message: `Couldn't set up this install's Trails access (${result.reason ?? 'unknown'}). Try again shortly.`
    });
  }
}

// Post-login Builder provisioning: gives every agent its own Sequence Builder
// project + access key (indexer and Trails quota) with zero manual steps.
// Signs an ETHAuth proof with an ephemeral EOA, exactly like `setup` always
// did, but runs automatically after `wallet login`. Best-effort by contract:
// this function never throws; a failure must never fail a completed login.

import { ethers } from 'ethers';

import { getAuthToken, createProject, getDefaultAccessKey } from './builder-api.ts';
import { generateEthAuthProof } from './ethauth.ts';
import { loadBuilderConfigRaw, saveBuilderConfig } from './storage.ts';

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

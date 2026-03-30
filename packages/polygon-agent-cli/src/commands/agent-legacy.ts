// Legacy aliases for backward compatibility with the old flat command structure.
// These re-use process.argv parsing since they're invoked as top-level commands
// (e.g. `polygon-agent register` instead of `polygon-agent agent register`).
// They delegate to the same underlying logic via yargs programmatic invocation.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Contract, Interface, JsonRpcProvider } from 'ethers';

import { runDappClientTx } from '../lib/dapp-client.ts';
import {
  resolveNetwork,
  formatUnits,
  getExplorerUrl,
  getRpcUrl,
  fileCoerce
} from '../lib/utils.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const REPUTATION_REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';

const contractsDir = path.resolve(__dirname, '..', '..', 'contracts');
const IDENTITY_ABI = JSON.parse(
  fs.readFileSync(path.join(contractsDir, 'IdentityRegistry.json'), 'utf8')
);
const REPUTATION_ABI = JSON.parse(
  fs.readFileSync(path.join(contractsDir, 'ReputationRegistry.json'), 'utf8')
);

// Simple arg parser for legacy commands (reads from process.argv)
function getArg(flag: string): string | null {
  const args = process.argv.slice(2);
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) return null;
  return fileCoerce(args[idx + 1]);
}

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

export async function registerAgent(): Promise<void> {
  const walletName = getArg('--wallet') || 'main';
  const agentName = getArg('--name');
  const agentURI = getArg('--agent-uri') || getArg('--uri');
  const metadataStr = getArg('--metadata');
  const broadcast = hasFlag('--broadcast');

  try {
    const iface = new Interface(IDENTITY_ABI);
    let data: string;

    const metadata: { metadataKey: string; metadataValue: Uint8Array }[] = [];
    if (metadataStr) {
      const pairs = metadataStr.split(',');
      for (const pair of pairs) {
        const [key, value] = pair.split('=');
        if (key && value) {
          metadata.push({
            metadataKey: key.trim(),
            metadataValue: Buffer.from(value.trim(), 'utf8')
          });
        }
      }
    }

    if (agentName) {
      metadata.push({
        metadataKey: 'name',
        metadataValue: Buffer.from(agentName, 'utf8')
      });
    }

    if (agentURI && metadata.length > 0) {
      data = iface.encodeFunctionData('register(string,(string,bytes)[])', [agentURI, metadata]);
    } else if (metadata.length > 0) {
      data = iface.encodeFunctionData('register(string,(string,bytes)[])', ['', metadata]);
    } else if (agentURI) {
      data = iface.encodeFunctionData('register(string)', [agentURI]);
    } else {
      data = iface.encodeFunctionData('register()', []);
    }

    const { walletAddress, txHash, dryRun } = await runDappClientTx({
      walletName,
      chainId: 137,
      transactions: [{ to: IDENTITY_REGISTRY, value: 0n, data }],
      broadcast
    });

    if (dryRun) return;

    const network = resolveNetwork('polygon');
    const explorerUrl = getExplorerUrl(network, txHash ?? '');

    console.log(
      JSON.stringify(
        {
          ok: true,
          walletName,
          walletAddress,
          contract: 'IdentityRegistry',
          contractAddress: IDENTITY_REGISTRY,
          agentName: agentName || 'Anonymous',
          agentURI: agentURI || 'Not provided',
          metadataCount: metadata.length,
          txHash,
          explorerUrl,
          message: 'Agent registered! Check transaction for agentId in Registered event.'
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: (error as Error).message,
          stack: (error as Error).stack
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

export async function getAgentWallet(): Promise<void> {
  const agentId = getArg('--agent-id');
  if (!agentId) {
    console.error(JSON.stringify({ ok: false, error: 'Missing --agent-id parameter' }));
    process.exit(1);
  }

  try {
    const network = resolveNetwork('polygon');
    const provider = new JsonRpcProvider(getRpcUrl(network));
    const contract = new Contract(IDENTITY_REGISTRY, IDENTITY_ABI, provider);
    const walletAddress = await contract.getAgentWallet(agentId);

    console.log(
      JSON.stringify(
        {
          ok: true,
          agentId,
          agentWallet: walletAddress,
          hasWallet: walletAddress !== '0x0000000000000000000000000000000000000000'
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: (error as Error).message }));
    process.exit(1);
  }
}

export async function getMetadata(): Promise<void> {
  const agentId = getArg('--agent-id');
  const key = getArg('--key');

  if (!agentId || !key) {
    console.error(JSON.stringify({ ok: false, error: 'Missing --agent-id or --key parameter' }));
    process.exit(1);
  }

  try {
    const network = resolveNetwork('polygon');
    const provider = new JsonRpcProvider(getRpcUrl(network));
    const contract = new Contract(IDENTITY_REGISTRY, IDENTITY_ABI, provider);
    const valueBytes = await contract.getMetadata(agentId, key);
    const value = Buffer.from(valueBytes.slice(2), 'hex').toString('utf8');

    console.log(JSON.stringify({ ok: true, agentId, key, value }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: (error as Error).message }));
    process.exit(1);
  }
}

export async function getReputation(): Promise<void> {
  const agentId = getArg('--agent-id');
  const tag1 = getArg('--tag1') || '';
  const tag2 = getArg('--tag2') || '';

  if (!agentId) {
    console.error(JSON.stringify({ ok: false, error: 'Missing --agent-id parameter' }));
    process.exit(1);
  }

  try {
    const network = resolveNetwork('polygon');
    const provider = new JsonRpcProvider(getRpcUrl(network));
    const contract = new Contract(REPUTATION_REGISTRY, REPUTATION_ABI, provider);

    const clients = await contract.getClients(agentId);
    const [count, summaryValue, summaryValueDecimals] = await contract.getSummary(
      agentId,
      clients,
      tag1,
      tag2
    );

    const score = formatUnits(summaryValue, summaryValueDecimals);

    console.log(
      JSON.stringify(
        {
          ok: true,
          agentId,
          feedbackCount: Number(count),
          reputationScore: score,
          decimals: summaryValueDecimals,
          clientCount: clients.length,
          tag1: tag1 || 'all',
          tag2: tag2 || 'all'
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: (error as Error).message }));
    process.exit(1);
  }
}

export async function giveFeedback(): Promise<void> {
  const walletName = getArg('--wallet') || 'main';
  const agentId = getArg('--agent-id');
  const value = getArg('--value');
  const tag1 = getArg('--tag1') || '';
  const tag2 = getArg('--tag2') || '';
  const endpoint = getArg('--endpoint') || '';
  const feedbackURI = getArg('--feedback-uri') || '';
  const broadcast = hasFlag('--broadcast');

  if (!agentId || !value) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: 'Missing required parameters: --agent-id, --value'
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  try {
    const valueFloat = parseFloat(value);
    const decimals = 2;
    const valueInt = BigInt(Math.round(valueFloat * Math.pow(10, decimals)));

    const iface = new Interface(REPUTATION_ABI);
    const data = iface.encodeFunctionData('giveFeedback', [
      agentId,
      valueInt,
      decimals,
      tag1,
      tag2,
      endpoint,
      feedbackURI,
      '0x0000000000000000000000000000000000000000000000000000000000000000'
    ]);

    const { walletAddress, txHash, dryRun } = await runDappClientTx({
      walletName,
      chainId: 137,
      transactions: [{ to: REPUTATION_REGISTRY, value: 0n, data }],
      broadcast
    });

    if (dryRun) return;

    const network = resolveNetwork('polygon');
    const explorerUrl = getExplorerUrl(network, txHash ?? '');

    console.log(
      JSON.stringify(
        {
          ok: true,
          walletName,
          walletAddress,
          agentId,
          value: valueFloat,
          tag1,
          tag2,
          endpoint,
          txHash,
          explorerUrl,
          message: 'Feedback submitted successfully'
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: (error as Error).message,
          stack: (error as Error).stack
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

export async function readAllFeedback(): Promise<void> {
  const agentId = getArg('--agent-id');
  const tag1 = getArg('--tag1') || '';
  const tag2 = getArg('--tag2') || '';
  const includeRevoked = hasFlag('--include-revoked');

  if (!agentId) {
    console.error(JSON.stringify({ ok: false, error: 'Missing --agent-id parameter' }));
    process.exit(1);
  }

  try {
    const network = resolveNetwork('polygon');
    const provider = new JsonRpcProvider(getRpcUrl(network));
    const contract = new Contract(REPUTATION_REGISTRY, REPUTATION_ABI, provider);

    const clients = await contract.getClients(agentId);
    const [clientsList, indexes, values, decimals, tag1s, tag2s, revoked] =
      await contract.readAllFeedback(agentId, clients, tag1, tag2, includeRevoked);

    const feedback = [];
    for (let i = 0; i < clientsList.length; i++) {
      feedback.push({
        client: clientsList[i],
        index: Number(indexes[i]),
        value: formatUnits(values[i], decimals[i]),
        tag1: tag1s[i],
        tag2: tag2s[i],
        revoked: revoked[i]
      });
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          agentId,
          feedbackCount: feedback.length,
          feedback
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: (error as Error).message }));
    process.exit(1);
  }
}

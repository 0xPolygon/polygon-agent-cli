import type { CommandModule } from 'yargs';

import { Contract, Interface, JsonRpcProvider } from 'ethers';

import IDENTITY_ABI from '../../contracts/IdentityRegistry.json' with { type: 'json' };
import REPUTATION_ABI from '../../contracts/ReputationRegistry.json' with { type: 'json' };
import { resolveBroadcast, withWriteFlags } from '../lib/mode.ts';
import { runTx as runDappClientTx } from '../lib/tx-dispatch.ts';
import {
  resolveNetwork,
  formatUnits,
  getExplorerUrl,
  getRpcUrl,
  fileCoerce
} from '../lib/utils.ts';

const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const REPUTATION_REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';

// --- register ---
async function handleRegister(argv: {
  wallet: string;
  name?: string;
  'agent-uri'?: string;
  uri?: string;
  metadata?: string;
  broadcast?: boolean;
  dryRun?: boolean;
}): Promise<void> {
  const walletName = argv.wallet;
  const agentName = argv.name;
  const agentURI = argv['agent-uri'] || argv.uri;
  const metadataStr = argv.metadata;
  const broadcast = resolveBroadcast(argv);

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

// --- identity (agent wallet + optional metadata lookup) ---
async function handleIdentity(argv: { 'agent-id': string; key?: string }): Promise<void> {
  const agentId = argv['agent-id'];
  const key = argv.key;

  try {
    const network = resolveNetwork('polygon');
    const provider = new JsonRpcProvider(getRpcUrl(network));
    const contract = new Contract(IDENTITY_REGISTRY, IDENTITY_ABI, provider);

    const walletAddress = await contract.getAgentWallet(agentId);
    const result: Record<string, unknown> = {
      ok: true,
      agentId,
      agentWallet: walletAddress,
      hasWallet: walletAddress !== '0x0000000000000000000000000000000000000000'
    };

    if (key) {
      const valueBytes = await contract.getMetadata(agentId, key);
      result.key = key;
      result.value = Buffer.from(valueBytes.slice(2), 'hex').toString('utf8');
    }

    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: (error as Error).message }, null, 2));
    process.exit(1);
  }
}

// --- reputation ---
async function handleReputation(argv: {
  'agent-id': string;
  tag1?: string;
  tag2?: string;
}): Promise<void> {
  const agentId = argv['agent-id'];
  const tag1 = argv.tag1 || '';
  const tag2 = argv.tag2 || '';

  try {
    const network = resolveNetwork('polygon');
    const provider = new JsonRpcProvider(getRpcUrl(network));

    const contract = new Contract(REPUTATION_REGISTRY, REPUTATION_ABI, provider);

    const clients = await contract.getClients(agentId);

    if (clients.length === 0) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            agentId,
            feedbackCount: 0,
            reputationScore: '0',
            clientCount: 0,
            tag1: tag1 || 'all',
            tag2: tag2 || 'all',
            message: 'No feedback received yet'
          },
          null,
          2
        )
      );
      return;
    }

    const [count, summaryValue, summaryValueDecimals] = await contract.getSummary(
      agentId,
      [...clients],
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
          decimals: Number(summaryValueDecimals),
          clientCount: clients.length,
          tag1: tag1 || 'all',
          tag2: tag2 || 'all'
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
          error: (error as Error).message
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

// --- feedback ---
async function handleFeedback(argv: {
  wallet: string;
  'agent-id': string;
  value: string;
  tag1?: string;
  tag2?: string;
  endpoint?: string;
  'feedback-uri'?: string;
  broadcast?: boolean;
  dryRun?: boolean;
}): Promise<void> {
  const walletName = argv.wallet;
  const agentId = argv['agent-id'];
  const value = argv.value;
  const tag1 = argv.tag1 || '';
  const tag2 = argv.tag2 || '';
  const endpoint = argv.endpoint || '';
  const feedbackURI = argv['feedback-uri'] || '';
  const broadcast = resolveBroadcast(argv);

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

// --- reviews ---
async function handleReviews(argv: {
  'agent-id': string;
  tag1?: string;
  tag2?: string;
  'include-revoked'?: boolean;
}): Promise<void> {
  const agentId = argv['agent-id'];
  const tag1 = argv.tag1 || '';
  const tag2 = argv.tag2 || '';
  const includeRevoked = argv['include-revoked'] || false;

  try {
    const network = resolveNetwork('polygon');
    const provider = new JsonRpcProvider(getRpcUrl(network));

    const contract = new Contract(REPUTATION_REGISTRY, REPUTATION_ABI, provider);

    const clients = await contract.getClients(agentId);

    const [clientsList, indexes, values, decimals, tag1s, tag2s, revoked] =
      await contract.readAllFeedback(agentId, [...clients], tag1, tag2, includeRevoked);

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
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: (error as Error).message
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

// --- Top-level ERC-8004 commands ---

export const registerCommand: CommandModule = {
  command: 'register',
  describe: 'Register agent identity on-chain (ERC-8004, Polygon mainnet)',
  builder: (y) =>
    withWriteFlags(
      y
        .option('wallet', { type: 'string', default: 'main', describe: 'Wallet name' })
        .option('name', { type: 'string', describe: 'Agent name', coerce: fileCoerce })
        .option('agent-uri', {
          type: 'string',
          alias: 'uri',
          describe: 'Agent URI',
          coerce: fileCoerce
        })
        .option('metadata', {
          type: 'string',
          describe: 'Key=value pairs (comma-separated)',
          coerce: fileCoerce
        })
    ),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleRegister(argv as any)
};

export const identityCommand: CommandModule = {
  command: 'identity',
  describe: 'Look up a registered agent: payment wallet and optional metadata',
  builder: (y) =>
    y
      .option('agent-id', {
        type: 'string',
        demandOption: true,
        describe: 'Agent ID',
        coerce: fileCoerce
      })
      .option('key', { type: 'string', describe: 'Metadata key to decode', coerce: fileCoerce }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleIdentity(argv as any)
};

export const reputationCommand: CommandModule = {
  command: 'reputation',
  describe: 'Get reputation score for an agent',
  builder: (y) =>
    y
      .option('agent-id', {
        type: 'string',
        demandOption: true,
        describe: 'Agent ID',
        coerce: fileCoerce
      })
      .option('tag1', { type: 'string', describe: 'Tag 1 filter' })
      .option('tag2', { type: 'string', describe: 'Tag 2 filter' }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleReputation(argv as any)
};

export const reviewsCommand: CommandModule = {
  command: 'reviews',
  describe: 'Read all feedback for an agent',
  builder: (y) =>
    y
      .option('agent-id', {
        type: 'string',
        demandOption: true,
        describe: 'Agent ID',
        coerce: fileCoerce
      })
      .option('tag1', { type: 'string', describe: 'Tag 1 filter' })
      .option('tag2', { type: 'string', describe: 'Tag 2 filter' })
      .option('include-revoked', {
        type: 'boolean',
        default: false,
        describe: 'Include revoked feedback'
      }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleReviews(argv as any)
};

export const feedbackCommand: CommandModule = {
  command: 'feedback',
  describe: 'Submit feedback for an agent',
  builder: (y) =>
    withWriteFlags(
      y
        .option('wallet', { type: 'string', default: 'main', describe: 'Wallet name' })
        .option('agent-id', {
          type: 'string',
          demandOption: true,
          describe: 'Agent ID',
          coerce: fileCoerce
        })
        .option('value', {
          type: 'string',
          demandOption: true,
          describe: 'Feedback score',
          coerce: fileCoerce
        })
        .option('tag1', { type: 'string', describe: 'Tag 1' })
        .option('tag2', { type: 'string', describe: 'Tag 2' })
        .option('endpoint', { type: 'string', describe: 'Endpoint' })
        .option('feedback-uri', { type: 'string', describe: 'Feedback URI' })
    ),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleFeedback(argv as any)
};

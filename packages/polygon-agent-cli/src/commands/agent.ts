import type { CommandModule } from 'yargs';

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

// ABIs are loaded relative to the package root (contracts/ directory)
const contractsDir = path.resolve(__dirname, '..', '..', 'contracts');
const IDENTITY_ABI = JSON.parse(
  fs.readFileSync(path.join(contractsDir, 'IdentityRegistry.json'), 'utf8')
);
const REPUTATION_ABI = JSON.parse(
  fs.readFileSync(path.join(contractsDir, 'ReputationRegistry.json'), 'utf8')
);

// --- register ---
async function handleRegister(argv: {
  wallet: string;
  name?: string;
  'agent-uri'?: string;
  uri?: string;
  metadata?: string;
  broadcast: boolean;
}): Promise<void> {
  const walletName = argv.wallet;
  const agentName = argv.name;
  const agentURI = argv['agent-uri'] || argv.uri;
  const metadataStr = argv.metadata;
  const broadcast = argv.broadcast;

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

// --- wallet (agent wallet) ---
async function handleAgentWallet(argv: { 'agent-id': string }): Promise<void> {
  const agentId = argv['agent-id'];

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

// --- metadata ---
async function handleMetadata(argv: { 'agent-id': string; key: string }): Promise<void> {
  const agentId = argv['agent-id'];
  const key = argv.key;

  try {
    const network = resolveNetwork('polygon');
    const provider = new JsonRpcProvider(getRpcUrl(network));

    const contract = new Contract(IDENTITY_REGISTRY, IDENTITY_ABI, provider);
    const valueBytes = await contract.getMetadata(agentId, key);
    const value = Buffer.from(valueBytes.slice(2), 'hex').toString('utf8');

    console.log(
      JSON.stringify(
        {
          ok: true,
          agentId,
          key,
          value
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
  broadcast: boolean;
}): Promise<void> {
  const walletName = argv.wallet;
  const agentId = argv['agent-id'];
  const value = argv.value;
  const tag1 = argv.tag1 || '';
  const tag2 = argv.tag2 || '';
  const endpoint = argv.endpoint || '';
  const feedbackURI = argv['feedback-uri'] || '';
  const broadcast = argv.broadcast;

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

// --- Main agent command ---
export const agentCommand: CommandModule = {
  command: 'agent',
  describe: 'ERC-8004 Agent Registry (register, wallet, metadata, reputation, feedback, reviews)',
  builder: (yargs) =>
    yargs
      .command({
        command: 'register',
        describe: 'Register agent identity',
        builder: (y) =>
          y
            .option('wallet', {
              type: 'string',
              default: 'main',
              describe: 'Wallet name'
            })
            .option('name', {
              type: 'string',
              describe: 'Agent name',
              coerce: fileCoerce
            })
            .option('agent-uri', {
              type: 'string',
              describe: 'Agent URI',
              coerce: fileCoerce
            })
            .option('uri', {
              type: 'string',
              describe: 'Agent URI (alias)',
              coerce: fileCoerce
            })
            .option('metadata', {
              type: 'string',
              describe: 'Key=value pairs (comma-separated)',
              coerce: fileCoerce
            })
            .option('broadcast', {
              type: 'boolean',
              default: false,
              describe: 'Execute transaction'
            }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: (argv) => handleRegister(argv as any)
      })
      .command({
        command: 'wallet',
        describe: 'Get agent payment wallet',
        builder: (y) =>
          y.option('agent-id', {
            type: 'string',
            demandOption: true,
            describe: 'Agent ID',
            coerce: fileCoerce
          }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: (argv) => handleAgentWallet(argv as any)
      })
      .command({
        command: 'metadata',
        describe: 'Get agent metadata',
        builder: (y) =>
          y
            .option('agent-id', {
              type: 'string',
              demandOption: true,
              describe: 'Agent ID',
              coerce: fileCoerce
            })
            .option('key', {
              type: 'string',
              demandOption: true,
              describe: 'Metadata key',
              coerce: fileCoerce
            }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: (argv) => handleMetadata(argv as any)
      })
      .command({
        command: 'reputation',
        describe: 'Get reputation score',
        builder: (y) =>
          y
            .option('agent-id', {
              type: 'string',
              demandOption: true,
              describe: 'Agent ID',
              coerce: fileCoerce
            })
            .option('tag1', {
              type: 'string',
              describe: 'Tag 1 filter'
            })
            .option('tag2', {
              type: 'string',
              describe: 'Tag 2 filter'
            }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: (argv) => handleReputation(argv as any)
      })
      .command({
        command: 'feedback',
        describe: 'Submit feedback',
        builder: (y) =>
          y
            .option('wallet', {
              type: 'string',
              default: 'main',
              describe: 'Wallet name'
            })
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
            .option('tag1', {
              type: 'string',
              describe: 'Tag 1'
            })
            .option('tag2', {
              type: 'string',
              describe: 'Tag 2'
            })
            .option('endpoint', {
              type: 'string',
              describe: 'Endpoint'
            })
            .option('feedback-uri', {
              type: 'string',
              describe: 'Feedback URI'
            })
            .option('broadcast', {
              type: 'boolean',
              default: false,
              describe: 'Execute transaction'
            }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: (argv) => handleFeedback(argv as any)
      })
      .command({
        command: 'reviews',
        describe: 'Read all feedback',
        builder: (y) =>
          y
            .option('agent-id', {
              type: 'string',
              demandOption: true,
              describe: 'Agent ID',
              coerce: fileCoerce
            })
            .option('tag1', {
              type: 'string',
              describe: 'Tag 1 filter'
            })
            .option('tag2', {
              type: 'string',
              describe: 'Tag 2 filter'
            })
            .option('include-revoked', {
              type: 'boolean',
              default: false,
              describe: 'Include revoked feedback'
            }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: (argv) => handleReviews(argv as any)
      })
      .demandCommand(1, '')
      .showHelpOnFail(true),
  handler: () => {}
};

import type { CommandModule } from 'yargs';

import { ethers } from 'ethers';

import { generateEthAuthProof } from '../lib/ethauth.ts';
import { saveBuilderConfig, loadBuilderConfig } from '../lib/storage.ts';
import { generateAgentName } from '../lib/utils.ts';

interface SetupArgs {
  name?: string;
  force?: boolean;
}

async function getAuthToken(proofString: string): Promise<string> {
  const apiUrl = process.env.SEQUENCE_BUILDER_API_URL || 'https://api.sequence.build';
  const url = `${apiUrl}/rpc/Builder/GetAuthToken`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ethauthProof: proofString })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GetAuthToken failed: ${response.status} ${errorText}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await response.json();

  if (!data.ok || !data.auth?.jwtToken) {
    throw new Error('GetAuthToken returned invalid response');
  }

  return data.auth.jwtToken;
}

async function createProject(
  name: string,
  jwtToken: string
): Promise<{ id: number; name: string }> {
  const apiUrl = process.env.SEQUENCE_BUILDER_API_URL || 'https://api.sequence.build';
  const url = `${apiUrl}/rpc/Builder/CreateProject`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwtToken}`
    },
    body: JSON.stringify({ name })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`CreateProject failed: ${response.status} ${errorText}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await response.json();

  if (!data.project) {
    throw new Error('CreateProject returned invalid response');
  }

  return data.project;
}

async function getDefaultAccessKey(projectId: number, jwtToken: string): Promise<string> {
  const apiUrl = process.env.SEQUENCE_BUILDER_API_URL || 'https://api.sequence.build';
  const url = `${apiUrl}/rpc/QuotaControl/GetDefaultAccessKey`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwtToken}`
    },
    body: JSON.stringify({ projectID: projectId })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GetDefaultAccessKey failed: ${response.status} ${errorText}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await response.json();

  if (!data.accessKey?.accessKey) {
    throw new Error('GetDefaultAccessKey returned invalid response');
  }

  return data.accessKey.accessKey;
}

export const setupCommand: CommandModule<object, SetupArgs> = {
  command: 'setup',
  describe: 'One-command project setup (EOA + auth + access key)',
  builder: (yargs) =>
    yargs
      .option('name', {
        type: 'string',
        describe: 'Project name'
      })
      .option('force', {
        type: 'boolean',
        describe: 'Recreate even if already configured',
        default: false
      }),
  handler: async (argv) => {
    const name = argv.name || generateAgentName();

    try {
      const existing = await loadBuilderConfig();
      if (existing && !argv.force) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              message: 'Builder already configured. Use --force to recreate.',
              eoaAddress: existing.eoaAddress,
              accessKey: existing.accessKey,
              projectId: existing.projectId
            },
            null,
            2
          )
        );
        return;
      }

      const wallet = ethers.Wallet.createRandom();
      const privateKey = wallet.privateKey;
      const eoaAddress = wallet.address;

      const ethAuthProof = await generateEthAuthProof(privateKey);
      const jwtToken = await getAuthToken(ethAuthProof);

      const project = await createProject(name, jwtToken);
      const accessKey = await getDefaultAccessKey(project.id, jwtToken);

      await saveBuilderConfig({
        privateKey,
        eoaAddress,
        accessKey,
        projectId: project.id
      });

      console.log(
        JSON.stringify(
          {
            ok: true,
            privateKey,
            eoaAddress,
            accessKey,
            projectId: project.id,
            projectName: project.name,
            message:
              'Builder configured successfully. Credentials saved to ~/.polygon-agent/builder.json (encrypted)'
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
};

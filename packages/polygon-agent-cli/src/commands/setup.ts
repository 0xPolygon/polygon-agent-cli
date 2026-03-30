import type { CommandModule } from 'yargs';

import { ethers } from 'ethers';
import React from 'react';

import { generateEthAuthProof } from '../lib/ethauth.ts';
import { saveBuilderConfig, loadBuilderConfig } from '../lib/storage.ts';
import { generateAgentName } from '../lib/utils.ts';
import { isTTY, inkRender } from '../ui/render.js';
import { SetupUI, getAuthToken, createProject, getDefaultAccessKey } from './setup-ui.js';

interface SetupArgs {
  name?: string;
  force?: boolean;
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

    if (!isTTY()) {
      // Non-TTY fallback: original JSON output
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
    } else {
      // TTY: Ink UI
      let setupFailed = false;
      try {
        await inkRender(React.createElement(SetupUI, { name, force: !!argv.force }));
      } catch {
        setupFailed = true;
      }
      if (setupFailed) process.exit(1);
    }
  }
};

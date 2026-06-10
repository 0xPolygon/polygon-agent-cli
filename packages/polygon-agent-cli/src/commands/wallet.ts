import type { CommandModule } from 'yargs';

import React from 'react';

import { getOmsClient } from '../lib/oms-client.ts';
import {
  listWallets,
  deleteWallet,
  saveOmsWalletPointer,
  loadOmsWalletPointer,
  deleteOmsWallet
} from '../lib/storage.ts';
import { isTTY, inkRender } from '../ui/render.js';
import { WalletListUI, WalletAddressUI } from './wallet-ui.js';

// Compact JSON output for AI agent consumers (single line, no stack traces)
function jsonOut(data: Record<string, unknown>): void {
  console.log(JSON.stringify(data));
}

// Read a line from stdin (for interactive OTP entry).
function readLine(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(promptText);
    const onData = (chunk: Buffer) => {
      process.stdin.off('data', onData);
      process.stdin.pause();
      resolve(chunk.toString('utf8').trim());
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

// --- Subcommand: wallet login (Sequence V3 email auth) ---
interface LoginArgs {
  name: string;
  email: string;
  code?: string;
}

async function handleLogin(argv: LoginArgs): Promise<void> {
  const name = argv.name;
  const email = argv.email;

  try {
    if (!email) throw new Error('--email is required');

    const oms = getOmsClient(name);

    // startEmailAuth + completeEmailAuth must happen in the same process — the
    // pending-auth commitment is held in memory, not persisted. So we send the
    // OTP, then obtain the code (either --code or an interactive stdin prompt).
    await oms.wallet.startEmailAuth({ email });

    let code = argv.code;
    if (!code) {
      process.stderr.write(`OTP sent to ${email}. `);
      code = await readLine('Enter the 6-digit code: ');
    }
    if (!code) throw new Error('No OTP code provided');

    const result = await oms.wallet.completeEmailAuth({ code });
    const walletAddress = result.walletAddress;

    await saveOmsWalletPointer(name, {
      walletAddress,
      loginMethod: 'email',
      email,
      createdAt: new Date().toISOString()
    });

    jsonOut({ ok: true, walletName: name, walletAddress, loginMethod: 'email' });
  } catch (error) {
    jsonOut({ ok: false, error: (error as Error).message });
    process.exit(1);
  }
}

// --- Subcommand: wallet logout ---
interface LogoutArgs {
  name: string;
}

async function handleLogout(argv: LogoutArgs): Promise<void> {
  const name = argv.name;
  try {
    try {
      const oms = getOmsClient(name);
      await oms.wallet.signOut();
    } catch {
      // signOut may fail if no session/config — proceed to delete local state anyway
    }
    await deleteOmsWallet(name);
    jsonOut({ ok: true, walletName: name, loggedOut: true });
  } catch (error) {
    jsonOut({ ok: false, error: (error as Error).message });
    process.exit(1);
  }
}

// --- Subcommand: wallet list ---
async function handleList(): Promise<void> {
  try {
    const wallets = await listWallets();

    const details: Array<{
      name: string;
      address: string;
      chain: string;
      chainId: number;
      loginMethod?: string;
    }> = [];
    for (const name of wallets) {
      const pointer = await loadOmsWalletPointer(name);
      if (pointer) {
        details.push({
          name,
          address: pointer.walletAddress,
          chain: 'polygon',
          chainId: 137,
          loginMethod: pointer.loginMethod
        });
      }
    }

    if (!isTTY()) {
      jsonOut({ ok: true, wallets: details });
    } else {
      await inkRender(React.createElement(WalletListUI, { wallets: details }));
    }
  } catch (error) {
    jsonOut({ ok: false, error: (error as Error).message });
    process.exit(1);
  }
}

// --- Subcommand: wallet address ---
interface AddressArgs {
  name: string;
}

async function handleAddress(argv: AddressArgs): Promise<void> {
  const name = argv.name;

  try {
    const pointer = await loadOmsWalletPointer(name);
    if (!pointer) {
      throw new Error(`Wallet not found: ${name}. Run: polygon-agent wallet login --email <addr>`);
    }

    if (!isTTY()) {
      jsonOut({
        ok: true,
        walletAddress: pointer.walletAddress,
        chain: 'polygon',
        chainId: 137,
        loginMethod: pointer.loginMethod
      });
    } else {
      await inkRender(
        React.createElement(WalletAddressUI, {
          name,
          address: pointer.walletAddress,
          chain: 'polygon',
          chainId: 137
        })
      );
    }
  } catch (error) {
    jsonOut({ ok: false, error: (error as Error).message });
    process.exit(1);
  }
}

// --- Subcommand: wallet remove ---
interface RemoveArgs {
  name: string;
}

async function handleRemove(argv: RemoveArgs): Promise<void> {
  const name = argv.name;

  try {
    // Remove OMS session state (storage + credential key) if present, plus the
    // wallet pointer file.
    await deleteOmsWallet(name);
    const deleted = await deleteWallet(name);

    if (!deleted) {
      throw new Error(`Wallet not found: ${name}`);
    }

    jsonOut({ ok: true, walletName: name });
  } catch (error) {
    jsonOut({ ok: false, error: (error as Error).message });
    process.exit(1);
  }
}

// --- Main wallet command ---
export const walletCommand: CommandModule = {
  command: 'wallet',
  describe: 'Manage wallets (login, logout, list, address, remove)',
  builder: (yargs) =>
    yargs
      .command({
        command: 'login',
        describe: 'Log in with email (Sequence V3 embedded wallet)',
        builder: (y) =>
          y
            .option('name', {
              type: 'string',
              default: 'main',
              describe: 'Wallet name'
            })
            .option('email', {
              type: 'string',
              demandOption: true,
              describe: 'Email address to authenticate with'
            })
            .option('code', {
              type: 'string',
              describe: 'OTP code (only if obtained out-of-band in this same session)'
            }),
        handler: (argv) => handleLogin(argv as unknown as LoginArgs)
      })
      .command({
        command: 'logout',
        describe: 'Log out and clear the local Sequence V3 session',
        builder: (y) =>
          y.option('name', {
            type: 'string',
            default: 'main',
            describe: 'Wallet name'
          }),
        handler: (argv) => handleLogout(argv as unknown as LogoutArgs)
      })
      .command({
        command: 'list',
        describe: 'List all wallets',
        handler: () => handleList()
      })
      .command({
        command: 'address',
        describe: 'Show wallet address',
        builder: (y) =>
          y.option('name', {
            type: 'string',
            default: 'main',
            describe: 'Wallet name'
          }),
        handler: (argv) => handleAddress(argv as unknown as AddressArgs)
      })
      .command({
        command: 'remove',
        describe: 'Remove wallet',
        builder: (y) =>
          y.option('name', {
            type: 'string',
            default: 'main',
            describe: 'Wallet name'
          }),
        handler: (argv) => handleRemove(argv as unknown as RemoveArgs)
      })
      .demandCommand(1, '')
      .showHelpOnFail(true),
  handler: () => {}
};

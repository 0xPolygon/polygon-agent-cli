import type { CommandModule } from 'yargs';

import React from 'react';

import { startOidcCallbackServer } from '../lib/oidc-callback-server.ts';
import { registerRelaySession, pollRelayForCallback } from '../lib/oidc-relay-client.ts';
import { getOmsClient, oidcRelayRedirectUri, oidcRelayBaseUrl } from '../lib/oms-client.ts';
import {
  listWallets,
  deleteWallet,
  saveOmsWalletPointer,
  loadOmsWalletPointer,
  deleteOmsWallet
} from '../lib/storage.ts';
import { isTTY, inkRender } from '../ui/render.js';
import { showFunding } from './operations.ts';
import { WalletListUI, WalletAddressUI } from './wallet-ui.js';

// Compact JSON output for AI agent consumers (single line, no stack traces)
function jsonOut(data: Record<string, unknown>): void {
  console.log(JSON.stringify(data));
}

// --- Subcommand: wallet login (Google OIDC browser flow — the only login) ---
interface LoginArgs {
  name: string;
  provider: string;
  port: number;
  timeout: number;
  force: boolean;
  fund: boolean;
  remote: boolean;
  relayUrl?: string;
}

// Print the auth URL (copy-paste fallback) and try to open it in a browser.
async function announceAuthUrl(url: string): Promise<void> {
  process.stderr.write(`\nOpen this URL to sign in:\n${url}\n\n`);
  try {
    const { default: open } = await import('open');
    await open(url);
  } catch {
    // open() can fail in headless/remote environments — the URL is already printed.
  }
  if (isTTY()) {
    process.stderr.write('Waiting for browser login… (Ctrl-C to cancel)\n');
  }
}

// Drive the OIDC redirect flow and return the callback URL to complete with.
// Two paths, both ending in a URL carrying ?code&state:
//   - remote: start OIDC pointed at OUR public relay's /api/oidc/cb, register the
//     handoff for this `state`, open the URL, then POLL the relay for code+state.
//     Works when the browser and CLI are on different machines.
//   - local:  a short-lived loopback server; the relay bounces the browser to it.
// Google only ever sees the Sequence relay (relayRedirectUri); our redirectUri
// rides inside the signed state either way.
async function obtainBrowserCallbackUrl(
  oms: ReturnType<typeof getOmsClient>,
  provider: 'google',
  argv: LoginArgs
): Promise<string> {
  const seqRelay = oidcRelayRedirectUri();

  if (argv.remote) {
    const relayBase = argv.relayUrl?.replace(/\/+$/, '') || oidcRelayBaseUrl();
    if (!relayBase) {
      throw new Error(
        'Remote login needs a relay URL. Set POLYGON_AGENT_OIDC_RELAY or pass --relay-url.'
      );
    }
    const { url, state } = await oms.wallet.startOidcRedirectAuth({
      provider,
      redirectUri: `${relayBase}/api/oidc/cb`,
      ...(seqRelay ? { relayRedirectUri: seqRelay } : {})
    });
    await registerRelaySession(relayBase, state);
    await announceAuthUrl(url);
    const cb = await pollRelayForCallback(relayBase, state, { timeoutMs: argv.timeout * 1000 });
    return `${relayBase}/api/oidc/cb?code=${encodeURIComponent(cb.code)}&state=${encodeURIComponent(cb.state)}`;
  }

  const server = await startOidcCallbackServer({
    port: argv.port,
    timeoutMs: argv.timeout * 1000
  });
  try {
    const { url } = await oms.wallet.startOidcRedirectAuth({
      provider,
      redirectUri: server.redirectUri,
      ...(seqRelay ? { relayRedirectUri: seqRelay } : {})
    });
    await announceAuthUrl(url);
    return await server.waitForCallbackUrl;
  } finally {
    server.close();
  }
}

async function handleLogin(argv: LoginArgs): Promise<void> {
  const { name, provider } = argv;

  if (provider !== 'google') {
    jsonOut({
      ok: false,
      error: `Unsupported provider "${provider}". Only "google" is wired today.`
    });
    process.exit(1);
  }

  try {
    const oms = getOmsClient(name);

    // Short-circuit if already logged in (the SDK restores the session from
    // storage on construction). startOidcRedirectAuth would clearSession(), so
    // re-login is opt-in via --force.
    if (!argv.force && oms.wallet.walletAddress) {
      jsonOut({
        ok: true,
        walletName: name,
        walletAddress: oms.wallet.walletAddress,
        alreadyLoggedIn: true
      });
      return;
    }

    const callbackUrl = await obtainBrowserCallbackUrl(oms, provider, argv);
    const result = await oms.wallet.completeOidcRedirectAuth({ callbackUrl });
    const walletAddress = result.walletAddress;

    await saveOmsWalletPointer(name, {
      walletAddress,
      loginMethod: 'google',
      createdAt: new Date().toISOString()
    });

    jsonOut({ ok: true, walletName: name, walletAddress, loginMethod: 'google' });

    // Chain the funding step right after a successful login: open the funding
    // page in the browser (interactive only) and show the URL panel. Skip with
    // --no-fund (e.g. for headless/scripted callers).
    if (argv.fund !== false) {
      await showFunding(name, walletAddress, 137, { openBrowser: true, remote: argv.remote });
    }
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
      throw new Error(`Wallet not found: ${name}. Run: polygon-agent wallet login`);
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
        describe: 'Log in with Google in the browser (add --remote for headless/remote hosts)',
        builder: (y) =>
          y
            .option('name', {
              type: 'string',
              default: 'main',
              describe: 'Wallet name'
            })
            .option('provider', {
              type: 'string',
              default: 'google',
              describe: 'OIDC provider (only "google" is supported today)'
            })
            .option('port', {
              type: 'number',
              default: 8765,
              describe: 'Localhost callback port for the local (non-remote) flow; default 8765'
            })
            .option('timeout', {
              type: 'number',
              default: 180,
              describe: 'Seconds to wait for the browser login before giving up'
            })
            .option('force', {
              type: 'boolean',
              default: false,
              describe: 'Re-login even if a session already exists'
            })
            .option('fund', {
              type: 'boolean',
              default: true,
              describe: 'Show the funding step after login (use --no-fund to skip)'
            })
            .option('remote', {
              type: 'boolean',
              default: false,
              describe:
                'Remote/headless: use the public OIDC relay + polling instead of a localhost callback (needs POLYGON_AGENT_OIDC_RELAY or --relay-url)'
            })
            .option('relay-url', {
              type: 'string',
              describe: 'Relay base URL for --remote (overrides POLYGON_AGENT_OIDC_RELAY)'
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

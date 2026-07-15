import type { CommandModule } from 'yargs';

import { randomBytes } from 'node:crypto';

import React from 'react';

import type { OmsLoginMethod } from '../lib/storage.ts';

import { runBrowserLogin } from '../lib/browser-login.ts';
import { ensureBuilderAccessKey, makeDefaultProvisionDeps } from '../lib/builder-provision.ts';
import { makeLoginRelay } from '../lib/login-relay-client.ts';
import { startOidcCallbackServer } from '../lib/oidc-callback-server.ts';
import {
  getOmsClient,
  loginUiBaseUrl,
  oidcRelayBaseUrl,
  oidcRelayRedirectUri
} from '../lib/oms-client.ts';
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
  local: boolean;
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

// Legacy --local flow: a short-lived loopback server; the relay bounces the
// browser to it. Only works when the browser runs on this machine.
async function obtainLoopbackCallbackUrl(
  oms: ReturnType<typeof getOmsClient>,
  provider: 'google',
  argv: LoginArgs
): Promise<string> {
  const seqRelay = oidcRelayRedirectUri();
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
  try {
    const oms = getOmsClient(argv.name);
    // Zero-setup onboarding: give this agent its own Builder project + access
    // key (indexer and Trails quota). Best-effort: a failure never fails the
    // login; re-running `wallet login` retries it, no fresh browser auth needed.
    async function provisionBuilder(walletAddress: string): Promise<boolean> {
      const provision = await ensureBuilderAccessKey(walletAddress, makeDefaultProvisionDeps());
      const ok = provision.provisioned || provision.reason === 'existing';
      if (!ok) {
        process.stderr.write(
          `Note: Builder provisioning failed (${provision.reason}). ` +
            'Indexer and Trails calls fall back to shared defaults; re-run `wallet login` to retry.\n'
        );
      }
      return ok;
    }

    // Short-circuit if already logged in (the SDK restores the session from
    // storage on construction). Starting a new auth would clearSession(), so
    // re-login is opt-in via --force. Builder provisioning still runs here:
    // a transient failure during the original login must be repairable by
    // re-running `wallet login` without forcing a fresh browser auth.
    if (!argv.force && oms.wallet.walletAddress) {
      const builderProvisioned = await provisionBuilder(oms.wallet.walletAddress);
      jsonOut({
        ok: true,
        walletName: argv.name,
        walletAddress: oms.wallet.walletAddress,
        alreadyLoggedIn: true,
        builderProvisioned
      });
      return;
    }

    let walletAddress: string;
    let loginMethod: OmsLoginMethod;

    if (argv.local) {
      if (argv.provider !== 'google') {
        throw new Error(
          `Unsupported provider "${argv.provider}". Only "google" works with --local.`
        );
      }
      const callbackUrl = await obtainLoopbackCallbackUrl(oms, 'google', argv);
      const result = await oms.wallet.completeOidcRedirectAuth({
        callbackUrl,
        walletSelection: 'automatic'
      });
      walletAddress = result.walletAddress;
      loginMethod = 'google';
    } else {
      if (argv.remote) {
        process.stderr.write('--remote is deprecated: the default login already works remotely.\n');
      }
      const relayBase = argv.relayUrl?.replace(/\/+$/, '') || oidcRelayBaseUrl();
      const result = await runBrowserLogin(
        {
          relay: makeLoginRelay(relayBase),
          wallet: oms.wallet,
          announce: announceAuthUrl,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now: () => Date.now(),
          randomSessionId: () => randomBytes(16).toString('base64url')
        },
        {
          relayBase,
          uiBase: loginUiBaseUrl(),
          seqRelay: oidcRelayRedirectUri(),
          timeoutMs: argv.timeout * 1000
        }
      );
      walletAddress = result.walletAddress;
      loginMethod = result.loginMethod;
    }

    await saveOmsWalletPointer(argv.name, {
      walletAddress,
      loginMethod,
      createdAt: new Date().toISOString()
    });

    const builderProvisioned = await provisionBuilder(walletAddress);

    jsonOut({ ok: true, walletName: argv.name, walletAddress, loginMethod, builderProvisioned });

    // Funding: the login page's success screen already directs the user onward,
    // so the browser flow only prints the panel; --local keeps opening the page.
    if (argv.fund !== false) {
      await showFunding(argv.name, walletAddress, 137, { openBrowser: argv.local });
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
      throw new Error(`Wallet not found: ${name}. Run: agent wallet login`);
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
        describe: 'Log in from the browser (choose Google or email on the login page)',
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
              describe: 'OIDC provider for --local (the browser flow picks the method on the page)'
            })
            .option('port', {
              type: 'number',
              default: 8765,
              describe: 'Localhost callback port for the --local loopback flow; default 8765'
            })
            .option('timeout', {
              type: 'number',
              default: 600,
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
              describe: '(deprecated) the default flow already works remotely'
            })
            .option('local', {
              type: 'boolean',
              default: false,
              describe:
                'Legacy loopback flow: raw Google URL + localhost callback (browser must be on this machine)'
            })
            .option('relay-url', {
              type: 'string',
              describe: 'Relay base URL (overrides POLYGON_AGENT_OIDC_RELAY)'
            }),
        handler: (argv) => handleLogin(argv as unknown as LoginArgs)
      })
      .command({
        command: 'logout',
        describe: 'Log out and clear the local OMS V3 session',
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

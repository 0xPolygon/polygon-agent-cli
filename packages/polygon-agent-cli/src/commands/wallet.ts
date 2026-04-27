import type { Argv, CommandModule } from 'yargs';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import React from 'react';

import {
  generateX25519Keypair,
  bytesToHex,
  hexToBytes,
  computeCodeHash,
  decryptSession
} from '@polygonlabs/agent-shared';

import { RelayClient } from '../lib/relay-client.ts';
import {
  saveWalletSession,
  loadWalletSession,
  saveWalletRequest,
  loadWalletRequest,
  deleteWalletRequest,
  listWallets,
  deleteWallet,
  sessionPayloadToWalletSession
} from '../lib/storage.ts';
import { normalizeChain, resolveNetwork, fileCoerce } from '../lib/utils.ts';
import { isTTY, inkRender } from '../ui/render.js';
import { WalletCreateUI, WalletListUI, WalletAddressUI } from './wallet-ui.js';

// Compact JSON output for AI agent consumers (single line, no stack traces)
function jsonOut(data: Record<string, unknown>): void {
  console.log(JSON.stringify(data));
}

// Base64 URL decode
function b64urlDecode(str: string): Buffer {
  const norm = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4));
  return Buffer.from(norm + pad, 'base64');
}

// Contracts always whitelisted in sessions.
// Spending limits (nativeLimit, usdcLimit, etc.) are enforced independently —
// whitelisting only permits the contract to be called, it does not grant token spend.
const AUTO_WHITELISTED_CONTRACTS = [
  '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', // ERC-8004 IdentityRegistry
  '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63', // ERC-8004 ReputationRegistry
  '0xABAAd93EeE2a569cF0632f39B10A9f5D734777ca', // ValueForwarder (required for send native POL)
  // NOTE: Trails deposit contract for swap --from POL is dynamic (changes per route/quote)
  // and cannot be reliably pre-whitelisted here.

  // Polygon mainnet (chainId 137) — default tokens
  '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // USDC (native)
  '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' // USDC.e (bridged)
];

// Additional contracts whitelisted when --defi flag is passed.
// Covers ERC-20s and yield vaults needed for swaps, bridges, and deposits.
const DEFI_CONTRACTS = [
  // Polygon mainnet (chainId 137) — additional ERC-20 token contracts
  '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', // USDT
  '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', // WETH

  // Polygon mainnet (chainId 137) — yield vaults
  '0x794a61358d6845594f94dc1db02a252b5b4814ad', // Aave V3 Pool (all markets)
  '0x781fb7f6d845e3be129289833b04d43aa8558c42', // Morpho Compound USDC
  '0xf5c81d25ee174d83f1fd202ca94ae6070d073ccf', // Morpho Compound WETH
  '0x3f33f9f7e2d7cfbcbdf8ea8b870a6e3d449664c2' // Morpho Compound POL
];

// Session permission options shared by create subcommands
interface SessionPermissionArgs {
  'native-limit'?: string;
  'usdc-limit'?: string;
  'usdt-limit'?: string;
  'token-limit'?: string[];
  contract?: string[];
  defi?: boolean;
  'usdc-to'?: string;
  'usdc-amount'?: string;
  'access-key'?: string;
}

function addSessionPermissionOptions<T>(yargs: Argv<T>): Argv<T & SessionPermissionArgs> {
  return yargs
    .option('native-limit', {
      type: 'string',
      describe: 'POL spending limit'
    })
    .option('usdc-limit', {
      type: 'string',
      describe: 'USDC spending limit'
    })
    .option('usdt-limit', {
      type: 'string',
      describe: 'USDT spending limit'
    })
    .option('token-limit', {
      type: 'string',
      array: true,
      describe: 'Token limit, repeatable (e.g. WETH:0.1)'
    })
    .option('contract', {
      type: 'string',
      array: true,
      describe: 'Whitelist contract, repeatable'
    })
    .option('defi', {
      type: 'boolean',
      describe: 'Whitelist DeFi contracts (swaps, yield vaults) in addition to defaults'
    })
    .option('usdc-to', {
      type: 'string',
      describe: 'One-off USDC transfer recipient'
    })
    .option('usdc-amount', {
      type: 'string',
      describe: 'One-off USDC transfer amount'
    })
    .option('access-key', {
      type: 'string',
      describe: 'Project access key'
    });
}

function applySessionPermissionParams(url: URL, argv: SessionPermissionArgs): void {
  const usdcTo = argv['usdc-to'];
  const usdcAmount = argv['usdc-amount'];
  if (usdcTo || usdcAmount) {
    if (!usdcTo || !usdcAmount) throw new Error('Must provide both --usdc-to and --usdc-amount');
    url.searchParams.set('erc20', 'usdc');
    url.searchParams.set('erc20To', usdcTo);
    url.searchParams.set('erc20Amount', usdcAmount);
  }

  const nativeLimit = argv['native-limit'];
  const usdcLimit = argv['usdc-limit'];
  const usdtLimit = argv['usdt-limit'];
  if (nativeLimit) url.searchParams.set('nativeLimit', nativeLimit);
  if (usdcLimit) url.searchParams.set('usdcLimit', usdcLimit);
  if (usdtLimit) url.searchParams.set('usdtLimit', usdtLimit);

  const tokenLimits = (argv['token-limit'] || [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  if (tokenLimits.length) url.searchParams.set('tokenLimits', tokenLimits.join(','));

  const baseContracts = argv.defi
    ? [...AUTO_WHITELISTED_CONTRACTS, ...DEFI_CONTRACTS]
    : AUTO_WHITELISTED_CONTRACTS;
  const userContracts = (argv.contract || []).map((s) => String(s || '').trim()).filter(Boolean);
  const allContracts = [...new Set([...baseContracts, ...userContracts])];
  url.searchParams.set('contracts', allContracts.join(','));
}

// Shared helper: decrypt ciphertext and save wallet session
async function decryptAndSaveSession(
  name: string,
  ciphertext: string,
  rid: string
): Promise<{ walletAddress: string; chainId: number; chain: string }> {
  const request = await loadWalletRequest(rid);
  if (!request) {
    throw new Error(`Request not found: ${rid}`);
  }

  const chain = normalizeChain(request.chain || 'polygon');

  const exp = Date.parse(request.expiresAt);
  if (Number.isFinite(exp) && Date.now() > exp) {
    throw new Error(
      `Request rid=${rid} is expired (expiresAt=${request.expiresAt}). Create a new request.`
    );
  }

  const publicKey = b64urlDecode(request.publicKeyB64u);
  const privateKey = b64urlDecode(request.privateKeyB64u);
  const ciphertextBuf = b64urlDecode(ciphertext);

  // Dynamic import to avoid bundling sealedbox if not needed
  const sealedbox = (await import('tweetnacl-sealedbox-js')).default;
  const decrypted = sealedbox.open(ciphertextBuf, publicKey, privateKey);
  if (!decrypted) {
    throw new Error('Failed to decrypt ciphertext');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payload: any;
  try {
    const { jsonRevivers } = await import('@0xsequence/dapp-client');
    payload = JSON.parse(Buffer.from(decrypted).toString('utf8'), jsonRevivers);
  } catch {
    payload = JSON.parse(Buffer.from(decrypted).toString('utf8'));
  }

  const walletAddress = payload.walletAddress;
  const chainId = payload.chainId;
  const explicitSession = payload.explicitSession;
  const implicit = payload.implicit;

  if (!walletAddress || typeof walletAddress !== 'string') {
    throw new Error('Missing walletAddress in payload');
  }
  if (!chainId || typeof chainId !== 'number') {
    throw new Error('Missing chainId in payload');
  }

  const net = resolveNetwork(chain);
  if (Number(net.chainId) !== Number(chainId)) {
    throw new Error(
      `Chain mismatch: request chain=${chain} (chainId=${net.chainId}) but payload chainId=${chainId}`
    );
  }

  if (!explicitSession || typeof explicitSession !== 'object') {
    throw new Error('Missing explicitSession in payload');
  }
  if (!explicitSession.pk || typeof explicitSession.pk !== 'string') {
    throw new Error('Missing explicitSession.pk in payload');
  }
  if (!implicit?.pk || !implicit?.attestation || !implicit?.identitySignature) {
    throw new Error('Missing implicit session in payload');
  }

  const implicitMeta = {
    guard: implicit.guard,
    loginMethod: implicit.loginMethod,
    userEmail: implicit.userEmail
  };

  const { jsonReplacers } = await import('@0xsequence/dapp-client');
  await saveWalletSession(name, {
    walletAddress,
    chainId,
    chain,
    projectAccessKey: request.projectAccessKey || null,
    explicitSession: JSON.stringify(explicitSession, jsonReplacers),
    sessionPk: explicitSession.pk,
    implicitPk: implicit.pk,
    implicitMeta: JSON.stringify(implicitMeta, jsonReplacers),
    implicitAttestation: JSON.stringify(implicit.attestation, jsonReplacers),
    implicitIdentitySig: JSON.stringify(implicit.identitySignature, jsonReplacers),
    createdAt: new Date().toISOString()
  });

  return { walletAddress, chainId, chain };
}

// --- Subcommand: wallet create ---
interface CreateArgs extends SessionPermissionArgs {
  name: string;
  chain: string;
  'print-url': boolean;
  timeout: number;
}

async function handleCreate(argv: CreateArgs): Promise<void> {
  if (argv['print-url']) {
    await handleCreateNoWait(argv);
  } else {
    await handleCreateAndWait(argv);
  }
}

async function handleCreateNoWait(argv: CreateArgs): Promise<void> {
  const name = argv.name;
  const chainArg = argv.chain;

  try {
    const chain = normalizeChain(chainArg);
    const connectorBase = (
      process.env.SEQUENCE_ECOSYSTEM_CONNECTOR_URL || 'https://agentconnect.polygon.technology'
    ).replace(/\/$/, '');

    const { secretKey: cliSk, publicKey: cliPk } = generateX25519Keypair();
    const cliPkHex = bytesToHex(cliPk);
    const cliSkHex = bytesToHex(cliSk);

    const relay = new RelayClient(connectorBase);
    const rid = await relay.createRequest(cliPkHex);

    const projectAccessKey = argv['access-key'] || process.env.SEQUENCE_PROJECT_ACCESS_KEY;
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await saveWalletRequest(rid, {
      rid,
      walletName: name,
      chain,
      createdAt: new Date().toISOString(),
      expiresAt,
      publicKeyB64u: '',
      privateKeyB64u: '',
      projectAccessKey: projectAccessKey || null,
      cliSkHex
    });

    const url = new URL(`${connectorBase}/link`);
    url.searchParams.set('rid', rid);
    url.searchParams.set('wallet', name);
    url.searchParams.set('chain', chain);
    if (projectAccessKey) url.searchParams.set('accessKey', projectAccessKey);
    applySessionPermissionParams(url, argv);

    const fullUrl = url.toString();
    jsonOut({
      ok: true,
      rid,
      approvalUrl: fullUrl,
      next: `polygon-agent wallet import --rid ${rid} --code <6-digit-code>`
    });
  } catch (error) {
    jsonOut({ ok: false, error: (error as Error).message });
    process.exit(1);
  }
}

async function handleCreateAndWait(argv: CreateArgs): Promise<void> {
  const name = argv.name;
  const chain = argv.chain;
  const tty = isTTY();
  let failed = false;
  try {
    // Always use Ink — renders to stdout (TTY) or stderr (non-TTY, keeps stdout clean for JSON)
    await inkRender(
      React.createElement(WalletCreateUI, {
        name,
        chain,
        timeout: argv.timeout,
        argv,
        tty,
        onComplete: (walletAddress: string, chainId: number, chainName: string) => {
          if (!tty) {
            jsonOut({ ok: true, walletAddress, chainId, chain: chainName });
          }
        },
        onError: (message: string) => {
          if (!tty) jsonOut({ ok: false, error: message });
        }
      }),
      { useStderr: !tty }
    );
  } catch {
    failed = true;
  }
  if (failed) process.exit(1);
}

// --- Subcommand: wallet import (alias: start-session) ---
interface ImportArgs {
  name: string;
  ciphertext?: string;
  rid?: string;
  code?: string;
}

async function handleImport(argv: ImportArgs): Promise<void> {
  const name = argv.name;

  try {
    // Relay-based code import
    if (argv.code) {
      const code = argv.code.trim();
      let rid = argv.rid;

      if (!rid) {
        // Find the most recent v2 request for this wallet
        const requestFiles = fs
          .readdirSync(path.join(os.homedir(), '.polygon-agent', 'requests'))
          .filter((f) => f.endsWith('.json'))
          .sort()
          .reverse();

        for (const file of requestFiles) {
          const requestRid = file.replace('.json', '');
          const request = await loadWalletRequest(requestRid);
          if (request && request.walletName === name && request.cliSkHex) {
            rid = requestRid;
            break;
          }
        }
        if (!rid)
          throw new Error(
            `No pending relay request for wallet '${name}'. Run: polygon-agent wallet create --print-url`
          );
      }

      const request = await loadWalletRequest(rid!);
      if (!request?.cliSkHex) throw new Error(`Request ${rid} is not a relay-based request`);

      const connectorBase = (
        process.env.SEQUENCE_ECOSYSTEM_CONNECTOR_URL || 'https://agentconnect.polygon.technology'
      ).replace(/\/$/, '');

      const relay = new RelayClient(connectorBase);
      const cliSk = hexToBytes(request.cliSkHex);
      const codeHashHex = bytesToHex(computeCodeHash(rid!, code));
      const encrypted = await relay.retrieve(rid!, codeHashHex);
      const payload = decryptSession(encrypted, cliSk, code, rid!);

      const session = sessionPayloadToWalletSession(payload);
      await saveWalletSession(name, session);
      await deleteWalletRequest(rid!);

      jsonOut({
        ok: true,
        walletAddress: session.walletAddress,
        chain: session.chain,
        chainId: session.chainId
      });
      return;
    }

    // Legacy ciphertext-based import (backward compat)
    if (!argv.ciphertext) {
      throw new Error('Provide either --code (relay mode) or --ciphertext (legacy mode)');
    }
    const ciphertext = fileCoerce(argv.ciphertext);
    let rid = argv.rid;

    if (!rid) {
      const requestFiles = fs
        .readdirSync(path.join(os.homedir(), '.polygon-agent', 'requests'))
        .filter((f) => f.endsWith('.json'));

      for (const file of requestFiles) {
        const requestRid = file.replace('.json', '');
        const request = await loadWalletRequest(requestRid);
        if (request && request.walletName === name) {
          rid = requestRid;
          break;
        }
      }
      if (!rid) throw new Error(`No matching request found for wallet '${name}'`);
    }

    const { walletAddress, chainId, chain } = await decryptAndSaveSession(name, ciphertext, rid);
    jsonOut({ ok: true, walletAddress, chainId, chain });
  } catch (error) {
    jsonOut({ ok: false, error: (error as Error).message });
    process.exit(1);
  }
}

// --- Subcommand: wallet list ---
async function handleList(): Promise<void> {
  try {
    const wallets = await listWallets();

    const details: Array<{ name: string; address: string; chain: string; chainId: number }> = [];
    for (const name of wallets) {
      const session = await loadWalletSession(name);
      if (session) {
        details.push({
          name,
          address: session.walletAddress,
          chain: session.chain,
          chainId: session.chainId
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
    const session = await loadWalletSession(name);
    if (!session) {
      throw new Error(`Wallet not found: ${name}`);
    }

    if (!isTTY()) {
      jsonOut({
        ok: true,
        walletAddress: session.walletAddress,
        chain: session.chain,
        chainId: session.chainId
      });
    } else {
      await inkRender(
        React.createElement(WalletAddressUI, {
          name,
          address: session.walletAddress,
          chain: session.chain,
          chainId: session.chainId
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
  describe: 'Manage wallets (create, import, list, address, remove)',
  builder: (yargs) =>
    yargs
      .command({
        command: 'create',
        describe: 'Create wallet (auto-waits for approval)',
        builder: (y) =>
          addSessionPermissionOptions(
            y
              .option('name', {
                type: 'string',
                default: 'main',
                describe: 'Wallet name'
              })
              .option('chain', {
                type: 'string',
                default: 'polygon',
                describe: 'Chain name or ID'
              })
              .option('print-url', {
                type: 'boolean',
                default: false,
                describe: 'Print approval URL and exit (non-interactive)'
              })
              .option('timeout', {
                type: 'number',
                default: 300,
                describe: 'Seconds to wait for approval before timing out'
              })
          ),
        handler: (argv) => handleCreate(argv as unknown as CreateArgs)
      })
      .command({
        command: 'import',
        describe: 'Import session from relay code or legacy ciphertext',
        builder: (y) =>
          y
            .option('name', {
              type: 'string',
              default: 'main',
              describe: 'Wallet name'
            })
            .option('code', {
              type: 'string',
              describe: '6-digit code from browser (for relay-based sessions)'
            })
            .option('ciphertext', {
              type: 'string',
              describe: 'Encrypted blob (legacy mode, or use @file)'
            })
            .option('rid', {
              type: 'string',
              describe: 'Request ID (auto-detected if omitted)'
            }),
        handler: (argv) => handleImport(argv as unknown as ImportArgs)
      })
      .command({
        command: 'start-session',
        describe: false,
        builder: (y) =>
          y
            .option('name', {
              type: 'string',
              default: 'main',
              describe: 'Wallet name'
            })
            .option('code', {
              type: 'string',
              describe: '6-digit code from browser (for relay-based sessions)'
            })
            .option('ciphertext', {
              type: 'string',
              describe: 'Encrypted session blob'
            })
            .option('rid', {
              type: 'string',
              describe: 'Request ID'
            }),
        handler: (argv) => handleImport(argv as unknown as ImportArgs)
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

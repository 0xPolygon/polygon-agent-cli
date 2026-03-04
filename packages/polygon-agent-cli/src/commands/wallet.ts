import type { Argv, CommandModule } from 'yargs';

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import nacl from 'tweetnacl';
import sealedbox from 'tweetnacl-sealedbox-js';

import {
  saveWalletSession,
  loadWalletSession,
  saveWalletRequest,
  loadWalletRequest,
  listWallets,
  deleteWallet
} from '../lib/storage.ts';
import { normalizeChain, resolveNetwork, fileCoerce } from '../lib/utils.ts';

// Base64 URL encode
function b64urlEncode(buf: Uint8Array): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

// Base64 URL decode
function b64urlDecode(str: string): Buffer {
  const norm = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4));
  return Buffer.from(norm + pad, 'base64');
}

// Generate random ID
function randomId(bytes = 16): string {
  return b64urlEncode(nacl.randomBytes(bytes));
}

// Contracts always whitelisted in sessions.
// Spending limits (nativeLimit, usdcLimit, etc.) are enforced independently —
// whitelisting only permits the contract to be called, it does not grant token spend.
const AUTO_WHITELISTED_CONTRACTS = [
  '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', // ERC-8004 IdentityRegistry
  '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63', // ERC-8004 ReputationRegistry
  '0xABAAd93EeE2a569cF0632f39B10A9f5D734777ca' // ValueForwarder (required for send native POL)
  // NOTE: Trails deposit contract for swap --from POL is dynamic (changes per route/quote)
  // and cannot be reliably pre-whitelisted here.
];

// Session permission options shared by create subcommands
interface SessionPermissionArgs {
  'native-limit'?: string;
  'usdc-limit'?: string;
  'usdt-limit'?: string;
  'token-limit'?: string[];
  contract?: string[];
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
  const usdcLimit = argv['usdc-limit'] || '50';
  const usdtLimit = argv['usdt-limit'];
  if (nativeLimit) url.searchParams.set('nativeLimit', nativeLimit);
  url.searchParams.set('usdcLimit', usdcLimit);
  if (usdtLimit) url.searchParams.set('usdtLimit', usdtLimit);

  const tokenLimits = (argv['token-limit'] || [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  if (tokenLimits.length) url.searchParams.set('tokenLimits', tokenLimits.join(','));

  const userContracts = (argv.contract || []).map((s) => String(s || '').trim()).filter(Boolean);
  const allContracts = [...new Set([...AUTO_WHITELISTED_CONTRACTS, ...userContracts])];
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

// cloudflared helpers
function cloudflaredDownloadInfo(): { url: string; tar: boolean } {
  const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
  const p = process.platform;
  const a = process.arch;
  if (p === 'darwin') {
    const arch = a === 'arm64' ? 'arm64' : 'amd64';
    return { url: `${base}cloudflared-darwin-${arch}.tgz`, tar: true };
  }
  if (p === 'linux') {
    const arch = a === 'arm64' ? 'arm64' : 'amd64';
    return { url: `${base}cloudflared-linux-${arch}`, tar: false };
  }
  if (p === 'win32') {
    return { url: `${base}cloudflared-windows-amd64.exe`, tar: false };
  }
  throw new Error(`Unsupported platform for cloudflared auto-download: ${p}/${a}`);
}

async function resolveCloudflared(): Promise<string> {
  try {
    execFileSync('cloudflared', ['--version'], { stdio: 'ignore' });
    return 'cloudflared';
  } catch {
    // not in PATH
  }

  const ext = process.platform === 'win32' ? '.exe' : '';
  const binDir = path.join(os.homedir(), '.polygon-agent', 'bin');
  const binPath = path.join(binDir, `cloudflared${ext}`);
  if (fs.existsSync(binPath)) return binPath;

  console.error('[cloudflared] Binary not found — downloading...');
  fs.mkdirSync(binDir, { recursive: true });

  const { url, tar } = cloudflaredDownloadInfo();
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Failed to download cloudflared: HTTP ${res.status} from ${url}`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (tar) {
    const tmpTar = binPath + '.tgz';
    fs.writeFileSync(tmpTar, buf);
    execFileSync('tar', ['-xzf', tmpTar, '-C', binDir], { stdio: 'ignore' });
    fs.unlinkSync(tmpTar);
    if (!fs.existsSync(binPath))
      throw new Error('cloudflared binary not found after extracting archive');
  } else {
    fs.writeFileSync(binPath, buf);
  }

  fs.chmodSync(binPath, 0o755);
  console.error(`[cloudflared] Downloaded to ${binPath}`);
  return binPath;
}

async function startCloudflaredTunnel(
  port: number
): Promise<{ publicUrl: string; process: ReturnType<typeof spawn> }> {
  const bin = await resolveCloudflared();
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let settled = false;
    const urlRe = /https:\/\/[a-zA-Z0-9][-a-zA-Z0-9]*\.trycloudflare\.com/;

    const onData = (chunk: Buffer) => {
      if (settled) return;
      const text = String(chunk);
      const match = text.match(urlRe);
      if (match) {
        settled = true;
        clearTimeout(timer);
        resolve({ publicUrl: match[0], process: proc });
      }
    };

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error('Timed out waiting for cloudflared tunnel URL (20s)'));
      }
    }, 20000);

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    proc.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`cloudflared exited with code ${code}`));
      }
    });
  });
}

function promiseWithResolvers<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function readBlobFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (data.includes('\n')) {
        process.stdin.pause();
        resolve(data.trim());
      }
    });
    process.stdin.on('error', reject);
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

// --- Subcommand: wallet create ---
interface CreateArgs extends SessionPermissionArgs {
  name: string;
  chain: string;
  'no-wait': boolean;
  timeout: number;
}

async function handleCreate(argv: CreateArgs): Promise<void> {
  if (argv['no-wait']) {
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
    const connectorUrl =
      process.env.SEQUENCE_ECOSYSTEM_CONNECTOR_URL || 'https://agentconnect.polygon.technology/';

    const rid = randomId(16);
    const kp = nacl.box.keyPair();
    const pub = b64urlEncode(kp.publicKey);
    const priv = b64urlEncode(kp.secretKey);

    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    const projectAccessKey = argv['access-key'] || process.env.SEQUENCE_PROJECT_ACCESS_KEY;

    await saveWalletRequest(rid, {
      rid,
      walletName: name,
      chain,
      createdAt,
      expiresAt,
      publicKeyB64u: pub,
      privateKeyB64u: priv,
      projectAccessKey: projectAccessKey || null
    });

    const url = new URL(connectorUrl);
    url.pathname = url.pathname.replace(/\/$/, '') + '/link';
    url.searchParams.set('rid', rid);
    url.searchParams.set('wallet', name);
    url.searchParams.set('pub', pub);
    url.searchParams.set('chain', chain);

    if (projectAccessKey) {
      url.searchParams.set('accessKey', projectAccessKey);
    }

    applySessionPermissionParams(url, argv);

    const fullUrl = url.toString();
    console.log(
      JSON.stringify(
        {
          ok: true,
          walletName: name,
          chain,
          rid,
          url: fullUrl,
          expiresAt,
          message:
            'IMPORTANT: Output the COMPLETE url below to the user. Do NOT truncate or shorten it. The user must open this exact URL in a browser to approve the wallet session.',
          approvalUrl: fullUrl
        },
        null,
        2
      )
    );
    console.error(`\nApprove wallet session (copy FULL url):\n${fullUrl}\n`);
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

async function handleCreateAndWait(argv: CreateArgs): Promise<void> {
  const name = argv.name;
  const chainArg = argv.chain;
  const timeoutSec = argv.timeout;

  try {
    const chain = normalizeChain(chainArg);
    const connectorUrl =
      process.env.SEQUENCE_ECOSYSTEM_CONNECTOR_URL || 'https://agentconnect.polygon.technology/';

    const rid = randomId(16);
    const kp = nacl.box.keyPair();
    const pub = b64urlEncode(kp.publicKey);
    const priv = b64urlEncode(kp.secretKey);

    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    const projectAccessKey = argv['access-key'] || process.env.SEQUENCE_PROJECT_ACCESS_KEY;

    await saveWalletRequest(rid, {
      rid,
      walletName: name,
      chain,
      createdAt,
      expiresAt,
      publicKeyB64u: pub,
      privateKeyB64u: priv,
      projectAccessKey: projectAccessKey || null
    });

    const callbackToken = randomId(24);
    const callbackPath = `/callback/${callbackToken}`;

    const { resolve: resolveCallback, promise: callbackPromise } = promiseWithResolvers<string>();

    const SUCCESS_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Session Approved</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0f;color:#e5e5e5}
.card{text-align:center;padding:2rem;border-radius:1rem;background:#16161f;border:1px solid #2a2a3a;max-width:360px}
.check{width:48px;height:48px;margin:0 auto 1rem;border-radius:50%;background:rgba(34,197,94,.15);display:flex;align-items:center;justify-content:center}
h2{margin:0 0 .5rem;font-size:1.25rem;color:#22c55e}p{margin:0;font-size:.875rem;color:#888}</style></head>
<body><div class="card"><div class="check"><svg width="24" height="24" fill="none" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
<h2>Session Approved</h2><p>You can close this tab and return to your CLI.</p></div></body></html>`;

    const MAX_BODY = 65536;
    const server = http.createServer((req, res) => {
      const corsOrigin = req.headers.origin || '*';
      const corsHeaders: Record<string, string> = {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        Vary: 'Origin'
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
      }
      if (req.method !== 'POST' || req.url !== callbackPath) {
        res.writeHead(404, {
          'Content-Type': 'application/json',
          ...corsHeaders
        });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      let body = '';
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          res.writeHead(413, corsHeaders);
          res.end('Payload too large');
          req.destroy();
          return;
        }
        body += chunk;
      });
      req.on('end', () => {
        try {
          const ct = (req.headers['content-type'] || '').toLowerCase();
          const data = ct.includes('application/x-www-form-urlencoded')
            ? Object.fromEntries(new URLSearchParams(body))
            : JSON.parse(body);
          if (!data.ciphertext || typeof data.ciphertext !== 'string') {
            res.writeHead(400, corsHeaders);
            res.end('Missing ciphertext');
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            ...corsHeaders
          });
          res.end(SUCCESS_HTML);
          resolveCallback(data.ciphertext);
        } catch {
          res.writeHead(400, corsHeaders);
          res.end('Invalid request body');
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.on('error', reject);
    });
    const port = (server.address() as { port: number }).port;

    let tunnel: { publicUrl: string; process: ReturnType<typeof spawn> } | null = null;
    let callbackUrl: string | null = null;
    let callbackMode = 'manual';

    try {
      tunnel = await startCloudflaredTunnel(port);
      callbackUrl = `${tunnel.publicUrl}${callbackPath}`;
      callbackMode = 'tunnel';
      console.error(`[tunnel] Public callback: ${tunnel.publicUrl}`);
    } catch (tunnelErr) {
      try {
        server.close();
      } catch {
        // ignore
      }
      console.error(
        `[tunnel] cloudflared unavailable (${(tunnelErr as Error)?.message || 'unknown'}), falling back to manual mode`
      );
    }

    const cleanup = () => {
      try {
        server.close();
      } catch {
        // ignore
      }
      try {
        tunnel?.process?.kill();
      } catch {
        // ignore
      }
    };
    process.once('SIGINT', () => {
      cleanup();
      process.exit(130);
    });

    const url = new URL(connectorUrl);
    url.pathname = url.pathname.replace(/\/$/, '') + '/link';
    url.searchParams.set('rid', rid);
    url.searchParams.set('wallet', name);
    url.searchParams.set('pub', pub);
    url.searchParams.set('chain', chain);
    if (callbackUrl) url.searchParams.set('callbackUrl', callbackUrl);
    if (projectAccessKey) url.searchParams.set('accessKey', projectAccessKey);
    applySessionPermissionParams(url, argv);

    const fullUrl = url.toString();
    const isManual = callbackMode === 'manual';
    console.log(
      JSON.stringify(
        {
          ok: true,
          walletName: name,
          chain,
          rid,
          url: fullUrl,
          callbackMode,
          expiresAt,
          message: isManual
            ? 'IMPORTANT: Output the COMPLETE approvalUrl to the user. After they approve in the browser, the encrypted blob will be displayed. Ask them to paste it back so you can complete the import.'
            : `IMPORTANT: Output the COMPLETE url below to the user. Do NOT truncate or shorten it. The user must open this exact URL in a browser to approve the wallet session. Waiting for approval (timeout ${timeoutSec}s)...`,
          approvalUrl: fullUrl
        },
        null,
        2
      )
    );
    console.error(`\nApprove wallet session (copy FULL url):\n${fullUrl}\n`);

    let ct: string;
    if (isManual) {
      console.error('After approving in the browser, the encrypted blob will be shown.');
      console.error('Paste it below and press Enter (or Ctrl+C to cancel):\n');
      process.stderr.write('> ');
      ct = await readBlobFromStdin();
      const tmpFile = path.join(os.tmpdir(), `polygon-session-${rid}.txt`);
      try {
        fs.writeFileSync(tmpFile, ct, 'utf8');
        console.error(`\n[manual] Blob saved to: ${tmpFile}`);
        console.error(
          `[manual] To import later: polygon-agent wallet import --ciphertext @${tmpFile}`
        );
      } catch {
        // ignore
      }
    } else {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Timed out waiting for callback (${timeoutSec}s)`)),
          timeoutSec * 1000
        )
      );
      try {
        ct = await Promise.race([callbackPromise, timeoutPromise]);
      } finally {
        cleanup();
      }
    }

    const {
      walletAddress,
      chainId,
      chain: resolvedChain
    } = await decryptAndSaveSession(name, ct, rid);

    console.log(
      JSON.stringify(
        {
          ok: true,
          walletName: name,
          walletAddress,
          chainId,
          chain: resolvedChain,
          message: 'Session started successfully. Wallet ready for operations.'
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

// --- Subcommand: wallet import (alias: start-session) ---
interface ImportArgs {
  name: string;
  ciphertext: string;
  rid?: string;
}

async function handleImport(argv: ImportArgs): Promise<void> {
  const name = argv.name;
  const ciphertext = fileCoerce(argv.ciphertext);
  let rid = argv.rid;

  try {
    if (!rid) {
      const requestFiles = fs
        .readdirSync(`${process.env.HOME}/.polygon-agent/requests`)
        .filter((f) => f.endsWith('.json'));

      for (const file of requestFiles) {
        const requestRid = file.replace('.json', '');
        const request = await loadWalletRequest(requestRid);
        if (request && request.walletName === name) {
          rid = requestRid;
          break;
        }
      }

      if (!rid) {
        throw new Error(
          `No matching request found for wallet '${name}'. Available: ${requestFiles.join(', ')}`
        );
      }
    }

    const { walletAddress, chainId, chain } = await decryptAndSaveSession(name, ciphertext, rid);

    console.log(
      JSON.stringify(
        {
          ok: true,
          walletName: name,
          walletAddress,
          chainId,
          chain,
          message: 'Session started successfully. Wallet ready for operations.'
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

// --- Subcommand: wallet list ---
async function handleList(): Promise<void> {
  try {
    const wallets = await listWallets();

    const details = [];
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

    console.log(
      JSON.stringify(
        {
          ok: true,
          wallets: details
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

    console.log(
      JSON.stringify(
        {
          ok: true,
          walletName: name,
          walletAddress: session.walletAddress,
          chain: session.chain,
          chainId: session.chainId
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

    console.log(
      JSON.stringify(
        {
          ok: true,
          walletName: name,
          message: 'Wallet removed successfully'
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

// --- Main wallet command ---
export const walletCommand: CommandModule = {
  command: 'wallet',
  describe: 'Manage wallets',
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
              .option('no-wait', {
                type: 'boolean',
                default: false,
                describe: 'Generate session URL only (manual copy-paste flow)'
              })
              .option('timeout', {
                type: 'number',
                default: 300,
                describe: 'Seconds to wait for callback before timing out'
              })
          ),
        handler: (argv) => handleCreate(argv as unknown as CreateArgs)
      })
      .command({
        command: 'import',
        describe: 'Import session from ciphertext',
        builder: (y) =>
          y
            .option('name', {
              type: 'string',
              default: 'main',
              describe: 'Wallet name'
            })
            .option('ciphertext', {
              type: 'string',
              demandOption: true,
              describe: 'Encrypted session blob',
              coerce: fileCoerce
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
            .option('ciphertext', {
              type: 'string',
              demandOption: true,
              describe: 'Encrypted session blob',
              coerce: fileCoerce
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
      .demandCommand(1, 'You must specify a wallet subcommand'),
  handler: () => {}
};

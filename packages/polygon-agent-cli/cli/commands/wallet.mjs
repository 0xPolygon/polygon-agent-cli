// Wallet commands - Session-based ecosystem wallet
// Renamed from create-request → wallet create
// Renamed from ingest-session → wallet start-session

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
  listWallets
} from '../../lib/storage.mjs';
import { getArg, getArgs, normalizeChain, resolveNetwork } from '../../lib/utils.mjs';

// Base64 URL encode — matches seq-eco.mjs exactly
function b64urlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

// Base64 URL decode — matches seq-eco.mjs exactly
function b64urlDecode(str) {
  const norm = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4));
  return Buffer.from(norm + pad, 'base64');
}

// Generate random ID — matches seq-eco.mjs exactly (base64url, NOT hex)
function randomId(bytes = 16) {
  return b64urlEncode(nacl.randomBytes(bytes));
}

// Contracts always whitelisted in sessions.
// Spending limits (nativeLimit, usdcLimit, etc.) are enforced independently —
// whitelisting only permits the contract to be called, it does not grant token spend.
const AUTO_WHITELISTED_CONTRACTS = [
  '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', // ERC-8004 IdentityRegistry
  '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63', // ERC-8004 ReputationRegistry
  '0xABAAd93EeE2a569cF0632f39B10A9f5D734777ca', // ValueForwarder (required for send native POL)
  '0x9c62f831c73c55deca97a2be8e6379336f8e0514', // Trails deposit contract (required for swap --from POL)
  '0x7e08701cc9194ef4ffd82421dd0d986d1b43d521'  // Trails swap router 
];

// Parse session permission args and append them to a URL
function applySessionPermissionParams(url, args) {
  // One-off ERC20 transfer (fixed recipient + amount) — must provide both or neither
  const usdcTo = getArg(args, '--usdc-to');
  const usdcAmount = getArg(args, '--usdc-amount');
  if (usdcTo || usdcAmount) {
    if (!usdcTo || !usdcAmount) throw new Error('Must provide both --usdc-to and --usdc-amount');
    url.searchParams.set('erc20', 'usdc');
    url.searchParams.set('erc20To', usdcTo);
    url.searchParams.set('erc20Amount', usdcAmount);
  }

  // Open-ended spending limits
  // Default usdcLimit ensures fee-payment permissions are always included (both native USDC
  // and Bridged USDC.e), so wallets funded only with ERC20 tokens work out-of-the-box.
  const nativeLimit = getArg(args, '--native-limit') || getArg(args, '--pol-limit');
  const usdcLimit = getArg(args, '--usdc-limit') || '50';
  const usdtLimit = getArg(args, '--usdt-limit');
  if (nativeLimit) url.searchParams.set('nativeLimit', nativeLimit);
  url.searchParams.set('usdcLimit', usdcLimit);
  if (usdtLimit) url.searchParams.set('usdtLimit', usdtLimit);

  // Generic token limits (repeatable: --token-limit USDC:50 --token-limit WETH:0.1)
  const tokenLimits = getArgs(args, '--token-limit')
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  if (tokenLimits.length) url.searchParams.set('tokenLimits', tokenLimits.join(','));

  // Contract whitelist — always include ERC-8004 contracts, plus any user-specified ones
  const userContracts = getArgs(args, '--contract')
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const allContracts = [...new Set([...AUTO_WHITELISTED_CONTRACTS, ...userContracts])];
  url.searchParams.set('contracts', allContracts.join(','));
}

// Wallet create command (formerly create-request)
export async function walletCreate() {
  const args = process.argv.slice(3);
  const name = getArg(args, '--name') || 'main';
  const chainArg = getArg(args, '--chain') || 'polygon';

  try {
    // Normalize chain name (don't resolve to Network object yet - that happens in wallet start-session)
    const chain = normalizeChain(chainArg);
    const connectorUrl =
      process.env.SEQUENCE_ECOSYSTEM_CONNECTOR_URL || 'https://agentconnect.polygon.technology/';

    // Generate NaCl keypair for encryption
    const rid = randomId(16);
    const kp = nacl.box.keyPair();
    const pub = b64urlEncode(kp.publicKey);
    const priv = b64urlEncode(kp.secretKey);

    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2 hours

    // Add project access key if available
    const projectAccessKey =
      getArg(args, '--access-key') || process.env.SEQUENCE_PROJECT_ACCESS_KEY;

    // Save request state (store chain as string, not Network object)
    await saveWalletRequest(rid, {
      rid,
      walletName: name,
      chain, // Just the normalized string like "polygon"
      createdAt,
      expiresAt,
      publicKeyB64u: pub,
      privateKeyB64u: priv,
      projectAccessKey: projectAccessKey || null
    });

    // Build connector URL
    const url = new URL(connectorUrl);
    url.pathname = url.pathname.replace(/\/$/, '') + '/link';
    url.searchParams.set('rid', rid);
    url.searchParams.set('wallet', name);
    url.searchParams.set('pub', pub);
    url.searchParams.set('chain', chain); // String chain name

    if (projectAccessKey) {
      url.searchParams.set('accessKey', projectAccessKey);
    }

    // Add session permission params (spending limits, token limits, contracts)
    applySessionPermissionParams(url, args);

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
          error: error.message,
          stack: error.stack
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

// Shared helper: decrypt ciphertext and save wallet session.
// Used by both walletStartSession() and walletCreateAndWait().
async function decryptAndSaveSession(name, ciphertext, rid) {
  // Load request
  const request = await loadWalletRequest(rid);
  if (!request) {
    throw new Error(`Request not found: ${rid}`);
  }

  const chain = normalizeChain(request.chain || 'polygon');

  // Check if request is expired
  const exp = Date.parse(request.expiresAt);
  if (Number.isFinite(exp) && Date.now() > exp) {
    throw new Error(
      `Request rid=${rid} is expired (expiresAt=${request.expiresAt}). Create a new request.`
    );
  }

  // Decrypt ciphertext with NaCl sealed box
  const publicKey = b64urlDecode(request.publicKeyB64u);
  const privateKey = b64urlDecode(request.privateKeyB64u);
  const ciphertextBuf = b64urlDecode(ciphertext);

  const decrypted = sealedbox.open(ciphertextBuf, publicKey, privateKey);
  if (!decrypted) {
    throw new Error('Failed to decrypt ciphertext');
  }

  // Parse decrypted payload (with dapp-client jsonRevivers if available)
  let payload;
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

  // Verify chain matches (request stores chain name, payload has chainId)
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

  // Prepare implicit session metadata
  const implicitMeta = {
    guard: implicit.guard,
    loginMethod: implicit.loginMethod,
    userEmail: implicit.userEmail
  };

  // Save wallet session (including all session data like seq-eco does)
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

// Wallet start-session / import command (formerly ingest-session)
export async function walletStartSession() {
  const args = process.argv.slice(3);
  const name = getArg(args, '--name') || 'main';
  let ciphertext = getArg(args, '--ciphertext');
  let rid = getArg(args, '--rid');

  if (!ciphertext) {
    console.error(JSON.stringify({ ok: false, error: 'Missing --ciphertext parameter' }, null, 2));
    process.exit(1);
  }

  try {
    // Support @filename syntax for reading ciphertext from file
    if (ciphertext.startsWith('@')) {
      const filePath = ciphertext.slice(1);
      try {
        ciphertext = fs.readFileSync(filePath, 'utf8').trim();
      } catch (err) {
        throw new Error(`Failed to read ciphertext from file '${filePath}': ${err.message}`);
      }
    }

    // Auto-detect rid if not provided
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
          error: error.message,
          stack: error.stack
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

// Returns the platform-specific cloudflared binary download URL and whether it's a tar archive.
function cloudflaredDownloadInfo() {
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

// Resolves the cloudflared binary path: system PATH → local cache → auto-download.
async function resolveCloudflared() {
  // 1. Already in PATH
  try {
    execFileSync('cloudflared', ['--version'], { stdio: 'ignore' });
    return 'cloudflared';
  } catch {}

  // 2. Previously downloaded to local cache
  const ext = process.platform === 'win32' ? '.exe' : '';
  const binDir = path.join(os.homedir(), '.polygon-agent', 'bin');
  const binPath = path.join(binDir, `cloudflared${ext}`);
  if (fs.existsSync(binPath)) return binPath;

  // 3. Auto-download from GitHub Releases
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
    // The archive extracts to a file named 'cloudflared' in binDir
    if (!fs.existsSync(binPath))
      throw new Error('cloudflared binary not found after extracting archive');
  } else {
    fs.writeFileSync(binPath, buf);
  }

  fs.chmodSync(binPath, 0o755);
  console.error(`[cloudflared] Downloaded to ${binPath}`);
  return binPath;
}

// Start a Cloudflare Quick Tunnel to the given local port.
// No account or token required — cloudflared provisions an ephemeral *.trycloudflare.com URL.
// Auto-downloads the cloudflared binary if not already installed.
async function startCloudflaredTunnel(port) {
  const bin = await resolveCloudflared();
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let settled = false;
    // URL appears in both stdout and stderr depending on version
    const urlRe = /https:\/\/[a-zA-Z0-9][-a-zA-Z0-9]*\.trycloudflare\.com/;

    const onData = (chunk) => {
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

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
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

// Wallet create-and-wait command: starts a local HTTP server, opens a Cloudflare Quick Tunnel
// so the connector UI can POST the encrypted session back, then waits for the callback.
// Falls back to manual paste if cloudflared is unavailable.
export async function walletCreateAndWait() {
  const args = process.argv.slice(3);
  const name = getArg(args, '--name') || 'main';
  const chainArg = getArg(args, '--chain') || 'polygon';
  const timeoutSec = parseInt(getArg(args, '--timeout') || '300', 10);

  try {
    const chain = normalizeChain(chainArg);
    const connectorUrl =
      process.env.SEQUENCE_ECOSYSTEM_CONNECTOR_URL || 'https://agentconnect.polygon.technology/';

    // Generate NaCl keypair for encryption
    const rid = randomId(16);
    const kp = nacl.box.keyPair();
    const pub = b64urlEncode(kp.publicKey);
    const priv = b64urlEncode(kp.secretKey);

    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    const projectAccessKey =
      getArg(args, '--access-key') || process.env.SEQUENCE_PROJECT_ACCESS_KEY;

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

    // One-shot secret token in the callback path prevents accidental hits on the public URL
    const callbackToken = randomId(24);
    const callbackPath = `/callback/${callbackToken}`;

    // Start local HTTP server on a random port (localhost only)
    const { resolve: resolveCallback, promise: callbackPromise } = promiseWithResolvers();

    const SUCCESS_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Session Approved</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0f;color:#e5e5e5}
.card{text-align:center;padding:2rem;border-radius:1rem;background:#16161f;border:1px solid #2a2a3a;max-width:360px}
.check{width:48px;height:48px;margin:0 auto 1rem;border-radius:50%;background:rgba(34,197,94,.15);display:flex;align-items:center;justify-content:center}
h2{margin:0 0 .5rem;font-size:1.25rem;color:#22c55e}p{margin:0;font-size:.875rem;color:#888}</style></head>
<body><div class="card"><div class="check"><svg width="24" height="24" fill="none" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
<h2>Session Approved</h2><p>You can close this tab and return to your CLI.</p></div></body></html>`;

    const MAX_BODY = 65536; // 64 KB
    const server = http.createServer((req, res) => {
      // Reflect the request Origin back so any dynamic tunnel URL is allowed.
      // Falling back to '*' covers same-origin and non-browser callers.
      const corsOrigin = req.headers.origin || '*';
      const corsHeaders = {
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
        res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      let body = '',
        size = 0;
      req.on('data', (chunk) => {
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
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders });
          res.end(SUCCESS_HTML);
          resolveCallback(data.ciphertext);
        } catch {
          res.writeHead(400, corsHeaders);
          res.end('Invalid request body');
        }
      });
    });

    await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.on('error', reject);
    });
    const port = server.address().port;

    // Open a Cloudflare Quick Tunnel — no account or token required.
    // cloudflared is auto-downloaded to ~/.polygon-agent/bin/ if not already installed.
    let tunnel = null;
    let callbackUrl = null;
    let callbackMode = 'manual';

    try {
      tunnel = await startCloudflaredTunnel(port);
      callbackUrl = `${tunnel.publicUrl}${callbackPath}`;
      callbackMode = 'tunnel';
      console.error(`[tunnel] Public callback: ${tunnel.publicUrl}`);
    } catch (tunnelErr) {
      try {
        server.close();
      } catch {}
      console.error(
        `[tunnel] cloudflared unavailable (${tunnelErr?.message || 'unknown'}), falling back to manual mode`
      );
    }

    const cleanup = () => {
      try {
        server.close();
      } catch {}
      try {
        tunnel?.process?.kill();
      } catch {}
    };
    process.once('SIGINT', () => {
      cleanup();
      process.exit(130);
    });

    // Build connector URL — only include callbackUrl when tunnel is up
    const url = new URL(connectorUrl);
    url.pathname = url.pathname.replace(/\/$/, '') + '/link';
    url.searchParams.set('rid', rid);
    url.searchParams.set('wallet', name);
    url.searchParams.set('pub', pub);
    url.searchParams.set('chain', chain);
    if (callbackUrl) url.searchParams.set('callbackUrl', callbackUrl);
    if (projectAccessKey) url.searchParams.set('accessKey', projectAccessKey);
    applySessionPermissionParams(url, args);

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

    let ciphertext;
    if (isManual) {
      console.error('After approving in the browser, the encrypted blob will be shown.');
      console.error('Paste it below and press Enter (or Ctrl+C to cancel):\n');
      process.stderr.write('> ');
      ciphertext = await readBlobFromStdin();
      const tmpFile = path.join(os.tmpdir(), `polygon-session-${rid}.txt`);
      try {
        fs.writeFileSync(tmpFile, ciphertext, 'utf8');
        console.error(`\n[manual] Blob saved to: ${tmpFile}`);
        console.error(
          `[manual] To import later: polygon-agent wallet import --ciphertext @${tmpFile}`
        );
      } catch {}
    } else {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Timed out waiting for callback (${timeoutSec}s)`)),
          timeoutSec * 1000
        )
      );
      try {
        ciphertext = await Promise.race([callbackPromise, timeoutPromise]);
      } finally {
        cleanup();
      }
    }

    // Decrypt and save session
    const {
      walletAddress,
      chainId,
      chain: resolvedChain
    } = await decryptAndSaveSession(name, ciphertext, rid);

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
          error: error.message,
          stack: error.stack
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

// Promise.withResolvers polyfill (Node <22)
function promiseWithResolvers() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Read a single line from stdin — used when no public tunnel is available
async function readBlobFromStdin() {
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

// Wallet list command
export async function walletList() {
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
          error: error.message
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

// Wallet address command
export async function walletAddress() {
  const args = process.argv.slice(3);
  const name = getArg(args, '--name') || 'main';

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
          error: error.message
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

// Wallet remove command
export async function walletRemove() {
  const args = process.argv.slice(3);
  const name = getArg(args, '--name') || 'main';

  try {
    const { deleteWallet } = await import('../../lib/storage.mjs');
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
          error: error.message
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CliState } from '@0xsequence/dapp-client-cli/state';

import { DappClient, TransportMode, jsonRevivers } from '@0xsequence/dapp-client';
import { isNativeFeeOption } from '@0xsequence/dapp-client-cli/fee-utils';
import { StateManager } from '@0xsequence/dapp-client-cli/state';
import { FileSequenceStorage, FileSessionStorage } from '@0xsequence/dapp-client-cli/storage';

import { loadWalletSession } from './storage.ts';

const STORAGE_DIR = path.join(os.homedir(), '.polygon-agent');
const DEFAULT_WALLET_URL = 'https://acme-wallet.ecosystem-demo.xyz';

interface Transaction {
  to: `0x${string}` | string;
  value?: bigint | number;
  data: string;
}

interface DappClientTxParams {
  walletName: string;
  chainId: number;
  transactions: Transaction[];
  broadcast: boolean;
  preferNativeFee?: boolean;
}

interface DappClientTxResult {
  walletAddress: string;
  txHash?: string;
  dryRun?: boolean;
  feeOptionUsed?: unknown;
}

// Install fetch logger for debugging network issues
let fetchLoggerInstalled = false;
function installFetchLogger(): void {
  if (fetchLoggerInstalled) return;
  const enabled = ['1', 'true', 'yes'].includes(
    String(
      process.env.SEQ_ECO_DEBUG_FETCH || process.env.POLYGON_AGENT_DEBUG_FETCH || ''
    ).toLowerCase()
  );
  if (!enabled) return;
  fetchLoggerInstalled = true;

  const logPath =
    process.env.POLYGON_AGENT_FETCH_LOG_PATH || path.join(STORAGE_DIR, 'fetch-debug.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  const origFetch = globalThis.fetch;
  if (typeof origFetch !== 'function') return;

  const redact = (s: string) => String(s).slice(0, 40000);
  const log = (line: string) =>
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`, 'utf8');

  globalThis.fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method || 'GET';
    const bodyPreview = init?.body ? redact(String(init.body)) : '';
    log(`→ ${method} ${url}`);
    if (bodyPreview) log(`  req.body=${bodyPreview}`);
    try {
      const res = await origFetch(input, init);
      let resText = '';
      try {
        resText = redact(await res.clone().text());
      } catch (e) {
        resText = `[unreadable: ${(e as Error)?.message || e}]`;
      }
      log(`← ${res.status} ${method} ${url}`);
      if (resText) log(`  res.body=${resText}`);
      return res;
    } catch (e) {
      log(`✖ fetch threw: ${method} ${url} :: ${(e as Error)?.stack || e}`);
      throw e;
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((globalThis as any).window) (globalThis as any).window.fetch = globalThis.fetch;
  log(`fetch logger enabled; logPath=${logPath}`);
}

function getPassphrase(): string {
  if (process.env.DAPP_CLIENT_CLI_PASSPHRASE) {
    return process.env.DAPP_CLIENT_CLI_PASSPHRASE;
  }

  const keyPath = path.join(STORAGE_DIR, '.encryption-key');
  if (!fs.existsSync(keyPath)) {
    throw new Error(
      'Missing ~/.polygon-agent/.encryption-key — run "polygon-agent wallet create" first'
    );
  }

  const keyBuf = fs.readFileSync(keyPath);
  return keyBuf.slice(0, 16).toString('hex');
}

function statePathFor(walletName: string): string {
  const dir = path.join(STORAGE_DIR, 'state', 'dapp-client-cli');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${walletName}.state.enc`);
}

async function syncStateAndGetStorage({
  walletName,
  chainId
}: {
  walletName: string;
  chainId: number;
}) {
  const session = await loadWalletSession(walletName);
  if (!session) {
    throw new Error(`Wallet not found: ${walletName}`);
  }

  const walletAddress = session.walletAddress as `0x${string}`;

  const explicitRaw = session.explicitSession;
  if (!explicitRaw) {
    throw new Error('Missing explicit session. Re-run wallet start-session.');
  }

  const explicitSession = JSON.parse(explicitRaw, jsonRevivers);
  if (!explicitSession?.pk) {
    throw new Error('Stored explicit session is missing pk; re-link wallet');
  }

  const deadline = explicitSession?.config?.deadline;
  if (deadline) {
    const deadlineSec = typeof deadline === 'bigint' ? Number(deadline) : Number(deadline);
    const nowSec = Math.floor(Date.now() / 1000);
    if (Number.isFinite(deadlineSec) && deadlineSec <= nowSec) {
      throw new Error(
        `Explicit session has expired (deadline ${deadlineSec}). Re-link wallet to mint a fresh session.`
      );
    }
  }

  const passphrase = getPassphrase();
  const statePath = statePathFor(walletName);

  const stateManager = new StateManager(statePath, passphrase);
  const storage = new FileSequenceStorage(stateManager, {
    suppressPendingRedirect: true
  });
  const sessionStorage = new FileSessionStorage(stateManager);

  const walletUrl = process.env.SEQUENCE_ECOSYSTEM_WALLET_URL || DEFAULT_WALLET_URL;
  const origin = process.env.SEQUENCE_DAPP_ORIGIN || 'https://agentconnect.polygon.technology';
  const projectAccessKey = session.projectAccessKey || process.env.SEQUENCE_PROJECT_ACCESS_KEY;
  if (!projectAccessKey)
    throw new Error('Missing SEQUENCE_PROJECT_ACCESS_KEY (not in wallet session or environment)');

  const keymachineUrl = process.env.SEQUENCE_KEYMACHINE_URL || 'https://keymachine.sequence.app';
  const nodesUrl = process.env.SEQUENCE_NODES_URL || 'https://nodes.sequence.app/{network}';
  const relayerUrl = process.env.SEQUENCE_RELAYER_URL || 'https://{network}-relayer.sequence.app';

  await stateManager.update((state: CliState) => {
    state.config.walletUrl = walletUrl;
    state.config.origin = origin;
    state.config.projectAccessKey = projectAccessKey;
    state.config.keymachineUrl = keymachineUrl;
    state.config.nodesUrl = nodesUrl;
    state.config.relayerUrl = relayerUrl;
    state.config.transportMode = 'redirect';

    state.storage.pendingRedirect = false;
    state.storage.tempSessionPk = null;
    state.storage.pendingRequest = null;
    state.storage.explicitSessions = [];
    state.storage.implicitSession = null;

    state.storage.sessionlessConnection = { walletAddress };
    state.storage.sessionlessConnectionSnapshot = { walletAddress };
  });

  const implicitMeta = session.implicitMeta ? JSON.parse(session.implicitMeta, jsonRevivers) : {};

  // guard is stored as a JSON string (serialized with jsonReplacers) — parse it back
  // so moduleAddresses is a proper Map<> rather than a plain object
  const guardRaw = implicitMeta.guard;
  const guard =
    guardRaw && typeof guardRaw === 'string'
      ? JSON.parse(guardRaw, jsonRevivers)
      : (guardRaw ?? undefined);

  await storage.saveExplicitSession({
    pk: explicitSession.pk as `0x${string}`,
    walletAddress,
    chainId,
    loginMethod: implicitMeta.loginMethod ?? explicitSession.loginMethod,
    userEmail: implicitMeta.userEmail ?? explicitSession.userEmail,
    guard
  });

  await stateManager.update((state: CliState) => {
    state.storage.sessionlessConnection = {
      walletAddress,
      loginMethod: implicitMeta.loginMethod ?? explicitSession.loginMethod,
      userEmail: implicitMeta.userEmail ?? explicitSession.userEmail,
      guard
    };
    state.storage.sessionlessConnectionSnapshot = {
      walletAddress,
      loginMethod: implicitMeta.loginMethod ?? explicitSession.loginMethod,
      userEmail: implicitMeta.userEmail ?? explicitSession.userEmail,
      guard
    };
  });

  if (session.implicitPk && session.implicitAttestation && session.implicitIdentitySig) {
    const implicitAttestation = JSON.parse(session.implicitAttestation, jsonRevivers);
    const implicitIdentitySignature = JSON.parse(session.implicitIdentitySig, jsonRevivers);
    await storage.saveImplicitSession({
      pk: session.implicitPk as `0x${string}`,
      walletAddress,
      chainId,
      attestation: implicitAttestation,
      identitySignature: implicitIdentitySignature
    });
  }

  await storage.setPendingRedirectRequest(false);
  await storage.getAndClearPendingRequest();
  await storage.getAndClearTempSessionPk();

  await sessionStorage.removeItem('');

  return {
    storage,
    sessionStorage,
    walletAddress,
    walletUrl,
    origin,
    projectAccessKey,
    keymachineUrl,
    nodesUrl,
    relayerUrl
  };
}

export async function runDappClientTx({
  walletName,
  chainId,
  transactions,
  broadcast,
  preferNativeFee
}: DappClientTxParams): Promise<DappClientTxResult> {
  const {
    storage,
    sessionStorage,
    walletAddress,
    walletUrl,
    origin,
    projectAccessKey,
    keymachineUrl,
    nodesUrl,
    relayerUrl
  } = await syncStateAndGetStorage({ walletName, chainId });

  // Node.js polyfill
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!(globalThis as any).window) (globalThis as any).window = { fetch: globalThis.fetch };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  else if (!(globalThis as any).window.fetch) (globalThis as any).window.fetch = globalThis.fetch;

  installFetchLogger();

  const client = new DappClient(walletUrl, origin, projectAccessKey, {
    transportMode: TransportMode.REDIRECT,
    keymachineUrl,
    nodesUrl,
    relayerUrl,
    sequenceStorage: storage,
    sequenceSessionStorage: sessionStorage,
    canUseIndexedDb: false
  });

  await client.initialize();
  if (!client.isInitialized) throw new Error('Client not initialized');

  if (!broadcast) {
    const bigintReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
    console.log(
      JSON.stringify(
        { ok: true, dryRun: true, walletName, walletAddress, transactions },
        bigintReplacer,
        2
      )
    );
    return { walletAddress, dryRun: true };
  }

  const debugFee = ['1', 'true', 'yes'].includes(
    String(
      process.env.SEQ_ECO_DEBUG_FEE_OPTIONS || process.env.POLYGON_AGENT_DEBUG_FEE || ''
    ).toLowerCase()
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let feeOpt: any;

  if (preferNativeFee) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const feeOptions = await client.getFeeOptions(chainId, transactions as any);
      if (debugFee) console.error(JSON.stringify({ debug: 'feeOptions', feeOptions }, null, 2));
      const nativeOpt = (feeOptions || []).find(isNativeFeeOption);
      if (nativeOpt) feeOpt = nativeOpt;
    } catch {
      // Fall through to ERC20 fee path
    }
  }

  if (!feeOpt) {
    try {
      const feeTokens = await client.getFeeTokens(chainId);
      if (debugFee) console.error(JSON.stringify({ debug: 'feeTokens', feeTokens }, null, 2));

      const paymentAddress = feeTokens?.paymentAddress;
      const tokens = Array.isArray(feeTokens?.tokens) ? feeTokens.tokens : [];

      const USDC_POLYGON = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let erc20Token: any = null;
      if (tokens.length > 0) {
        try {
          const { SequenceIndexer } = await import('@0xsequence/indexer');
          const chainIndexerUrl = `https://polygon-indexer.sequence.app`;
          const indexerKey = process.env.SEQUENCE_INDEXER_ACCESS_KEY || projectAccessKey;
          const indexer = new SequenceIndexer(chainIndexerUrl, indexerKey);
          const balRes = await indexer.getTokenBalances({
            accountAddress: walletAddress,
            includeMetadata: false
          });
          const heldAddresses = new Set(
            (balRes?.balances || []).map((b: { contractAddress?: string }) =>
              b.contractAddress?.toLowerCase()
            )
          );
          const heldFeeTokens = tokens.filter(
            (t: { contractAddress?: string }) =>
              t?.contractAddress && heldAddresses.has(t.contractAddress.toLowerCase())
          );
          erc20Token =
            heldFeeTokens.find(
              (t: { contractAddress?: string }) => t.contractAddress?.toLowerCase() === USDC_POLYGON
            ) ||
            heldFeeTokens.find((t: { symbol?: string }) => t?.symbol === 'USDC') ||
            heldFeeTokens[0] ||
            null;
        } catch {
          // Indexer unavailable — fall back to symbol matching
        }
        if (!erc20Token) {
          erc20Token =
            tokens.find(
              (t: { contractAddress?: string }) =>
                t?.contractAddress?.toLowerCase() === USDC_POLYGON
            ) ||
            tokens.find(
              (t: { contractAddress?: string; symbol?: string }) =>
                t?.contractAddress && t?.symbol === 'USDC'
            ) ||
            tokens.find((t: { contractAddress?: string }) => t?.contractAddress) ||
            null;
        }
      }

      if (paymentAddress && erc20Token) {
        const decimals = typeof erc20Token.decimals === 'number' ? erc20Token.decimals : 6;
        const feeValue = decimals >= 2 ? 10 ** (decimals - 2) : 1;
        feeOpt = {
          token: erc20Token,
          to: paymentAddress,
          value: String(feeValue),
          gasLimit: 0
        };
        if (debugFee) console.error(JSON.stringify({ debug: 'selectedFee', feeOpt }, null, 2));
      }
    } catch (e) {
      if (debugFee)
        console.error(
          JSON.stringify({ debug: 'getFeeTokens failed', error: (e as Error)?.message }, null, 2)
        );
    }
  }

  if (!feeOpt) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const feeOptions = await client.getFeeOptions(chainId, transactions as any);
      feeOpt = feeOptions?.[0];
    } catch (e) {
      throw new Error(`Unable to determine fee option: ${(e as Error)?.message}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const txHash = await client.sendTransaction(chainId, transactions as any, feeOpt);
  return { walletAddress, txHash, feeOptionUsed: feeOpt };
}

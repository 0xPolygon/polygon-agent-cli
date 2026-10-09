// The Polymarket trading account for an OMS wallet name: a CLI-generated key
// that controls a Polymarket Deposit Wallet. Polymarket's relayer deploys the
// wallet and runs its approvals and transfers, authorized by a builder API key
// minted from the same key. The OMS wallet never signs for Polymarket.

import fs from 'node:fs';
import path from 'node:path';

import { privateKeyToAccount } from 'viem/accounts';

import type { CipherData } from '../storage.ts';
import type { PendingDeposit } from './deposits.ts';
import type { OmsWalletLike } from './oms-key.ts';

import { CliError } from '../errors.ts';
import { getOmsClient } from '../oms-client.ts';
import { readJsonFile, writeJsonFile } from '../session/state.ts';
import { decrypt, encrypt, loadOmsWalletPointer, STORAGE_ROOT } from '../storage.ts';
import { formatUnits6 } from './amounts.ts';
import { bridgeStatus } from './bridge.ts';
import { loadPending } from './deposits.ts';
import {
  CTF,
  getPolymarketProxyWalletAddress,
  LEGACY_NEG_RISK_ADAPTER,
  PUSD,
  USDC_E
} from './gamma.ts';
import {
  backupTradingKey,
  findTradingKeyWallet,
  installTradingKeyReference,
  omsSigner
} from './oms-key.ts';
import { loadSdk, mapSdkError } from './sdk.ts';
import { pusdBalanceOf, withdrawAll } from './withdraw.ts';

export type AccountKind = 'deposit-wallet' | 'legacy-proxy';
export type StoredAccount = {
  kind: AccountKind;
  signer: string;
  wallet: string;
  createdAt: string;
};
type Creds = { key: string; secret: string; passphrase: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SecureClient = any;

export function accountDir(wallet: string): string {
  const dir = path.join(STORAGE_ROOT, 'polymarket', wallet);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// Read paths join only: they must not create the account directory.
export function accountFile(wallet: string, name: string): string {
  return path.join(STORAGE_ROOT, 'polymarket', wallet, name);
}

function readSecret(wallet: string, name: string): string | null {
  const data = readJsonFile(accountFile(wallet, name)) as CipherData | undefined;
  return data ? decrypt(data) : null;
}

function writeSecret(wallet: string, name: string, value: string): void {
  writeJsonFile({ file: path.join(accountDir(wallet), name), data: encrypt(value) });
}

export function loadAccount(wallet: string): StoredAccount | null {
  return (readJsonFile(accountFile(wallet, 'account.json')) as StoredAccount) ?? null;
}

export function requireAccount(wallet: string): StoredAccount {
  const acct = loadAccount(wallet);
  if (!acct) {
    throw new CliError({
      code: 'not_set_up',
      message: `No Polymarket account for wallet '${wallet}' yet.`,
      command: `agent polymarket setup --wallet ${wallet} --broadcast`
    });
  }
  return acct;
}

export function planSetup(wallet: string): { exists: boolean; account: StoredAccount | null } {
  const account = loadAccount(wallet);
  return { exists: account !== null, account };
}

function missingKeyError(wallet: string): CliError {
  return new CliError({
    code: 'not_set_up',
    message: `The Polymarket key for wallet '${wallet}' is missing.`,
    command: `agent polymarket setup --wallet ${wallet} --broadcast`
  });
}

// Builds a secure client for `signer`. Without a builder key the SDK can't deploy or
// relay, which is fine for an account that already exists.
async function createClient(p: {
  signer: unknown;
  acct: { kind: AccountKind; wallet?: string };
  builder: Creds | null;
  clob: Creds | null;
}): Promise<SecureClient> {
  const { root, node } = await loadSdk();
  try {
    return await root.createSecureClient({
      signer: p.signer,
      ...(p.acct.kind === 'legacy-proxy' ? { wallet: p.acct.wallet } : {}),
      ...(p.builder ? { apiKey: node.builderApiKey(p.builder) } : {}),
      ...(p.clob ? { credentials: p.clob } : {})
    } as never);
  } catch (err) {
    throw mapSdkError(err);
  }
}

const readCreds = (wallet: string, name: string): Creds | null => {
  const text = readSecret(wallet, name);
  return text ? (JSON.parse(text) as Creds) : null;
};

async function storedClient(
  wallet: string,
  acct: { kind: AccountKind; wallet?: string },
  signer: unknown
): Promise<SecureClient> {
  const clob = readCreds(wallet, 'clob.json');
  const client = await createClient({
    signer,
    acct,
    builder: readCreds(wallet, 'builder.json'),
    clob
  });
  if (!clob && client.credentials)
    writeSecret(wallet, 'clob.json', JSON.stringify(client.credentials));
  return client;
}

async function clientFor(
  wallet: string,
  acct: { kind: AccountKind; wallet?: string },
  key: string
): Promise<SecureClient> {
  const { viem } = await loadSdk();
  return storedClient(wallet, acct, viem.privateKey(key));
}

function keyBackedUpError(): CliError {
  return new CliError({
    code: 'not_set_up',
    message: 'The Polymarket key is not on this machine; it is backed up in your OMS account.',
    hint: 'Sign in with agent wallet login to use it.'
  });
}

// The live owner-mode OMS session for `wallet`, or null in session mode or when signed out.
async function ownerSession(wallet: string): Promise<OmsWalletLike | null> {
  const pointer = await loadOmsWalletPointer(wallet);
  if (!pointer || pointer.access === 'session') return null;
  const w = getOmsClient(wallet).wallet;
  return w.walletAddress ? w : null;
}

export async function getTradingClient(wallet: string): Promise<SecureClient> {
  const acct = requireAccount(wallet);
  const key = readSecret(wallet, 'key.json');
  if (key) return clientFor(wallet, acct, key);
  // The key is gone locally. In owner mode, sign through OMS as the backed-up key; never
  // generate a replacement, because only the old key controls the old account.
  const owner = await ownerSession(wallet);
  if (!owner) throw readBackup(wallet) ? keyBackedUpError() : missingKeyError(wallet);
  const found = await findTradingKeyWallet(owner, { address: acct.signer });
  if (!found) throw missingKeyError(wallet);
  return storedClient(
    wallet,
    acct,
    omsSigner(owner, { walletId: found.id, address: found.address })
  );
}

// The builder key authorizes gasless relayer calls (approvals, transfers). It is
// minted as the EOA itself; no deposit wallet is needed for that.
async function mintBuilderCreds(signer: unknown, address: string): Promise<Creds> {
  const { root, actions } = await loadSdk();
  try {
    const eoaClient = await root.createSecureClient({ signer, wallet: address } as never);
    return (await actions.createBuilderApiKey(eoaClient as never)) as Creds;
  } catch (err) {
    throw mapSdkError(err);
  }
}

async function mintBuilderKey(wallet: string, key: string, signer: string): Promise<void> {
  const { viem } = await loadSdk();
  const creds = await mintBuilderCreds(viem.privateKey(key), signer);
  writeSecret(wallet, 'builder.json', JSON.stringify(creds));
}

// Anything at or above this counts as the "max" approval the SDK grants.
const MAX_ALLOWANCE_FLOOR = 2n ** 128n;

const ERC20_ALLOWANCE_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' }
    ],
    outputs: [{ name: '', type: 'uint256' }]
  }
] as const;
const ERC1155_APPROVED_ABI = [
  {
    type: 'function',
    name: 'isApprovedForAll',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'operator', type: 'address' }
    ],
    outputs: [{ name: '', type: 'bool' }]
  }
] as const;

// A failed read of the chain (transport, HTTP, timeout, rate limit) is an upstream problem.
function mapChainReadError(err: unknown, what = 'the legacy NegRiskAdapter approvals'): CliError {
  if (err instanceof CliError) return err;
  const e = err as { status?: number; code?: number; message?: string; shortMessage?: string };
  const message = `Couldn't read ${what} from Polygon: ${e?.shortMessage ?? e?.message ?? String(err)}`;
  const limited = e?.status === 429 || e?.code === -32005;
  return new CliError({
    code: limited ? 'rate_limited' : 'upstream_unavailable',
    message,
    cause: err
  });
}

async function polygonReader() {
  const { createPublicClient, http } = await import('viem');
  const { polygon } = await import('viem/chains');
  const { getReadRpcUrl, resolveNetwork } = await import('../utils.ts');
  return createPublicClient({
    chain: polygon,
    transport: http(
      process.env.SEQUENCE_PROJECT_ACCESS_KEY
        ? getReadRpcUrl(resolveNetwork(polygon.id))
        : polygon.rpcUrls.default.http[0]
    )
  });
}

async function readLegacyNegRiskApprovals(
  client: SecureClient
): Promise<{ pusd: boolean; ctf: boolean }> {
  const chain = await polygonReader();
  const owner = client.account.wallet as `0x${string}`;
  try {
    const [allowance, ctf] = await Promise.all([
      chain.readContract({
        address: PUSD,
        abi: ERC20_ALLOWANCE_ABI,
        functionName: 'allowance',
        args: [owner, LEGACY_NEG_RISK_ADAPTER]
      }),
      chain.readContract({
        address: CTF,
        abi: ERC1155_APPROVED_ABI,
        functionName: 'isApprovedForAll',
        args: [owner, LEGACY_NEG_RISK_ADAPTER]
      })
    ]);
    return { pusd: allowance >= MAX_ALLOWANCE_FLOOR, ctf };
  } catch (err) {
    throw mapChainReadError(err);
  }
}

// The SDK's approval list omits the legacy NegRiskAdapter, which the CLOB still
// checks for neg-risk markets. True when both of its approvals are in place.
export async function legacyNegRiskApproved(client: SecureClient): Promise<boolean> {
  const have = await readLegacyNegRiskApprovals(client);
  return have.pusd && have.ctf;
}

// Sets only the legacy approvals that are missing. Returns whether it set anything.
export async function ensureLegacyNegRiskApprovals(client: SecureClient): Promise<boolean> {
  const have = await readLegacyNegRiskApprovals(client);
  try {
    if (!have.pusd) {
      const handle = await client.approveErc20({
        amount: 'max',
        spenderAddress: LEGACY_NEG_RISK_ADAPTER,
        tokenAddress: PUSD
      });
      await handle.wait();
    }
    if (!have.ctf) {
      const handle = await client.approveErc1155ForAll({
        operatorAddress: LEGACY_NEG_RISK_ADAPTER,
        tokenAddress: CTF
      });
      await handle.wait();
    }
  } catch (err) {
    throw mapSdkError(err);
  }
  return !have.pusd || !have.ctf;
}

// Returns the trading key, generating and storing one on first use. Deploys nothing.
// The key is a secret: callers keep it in memory only.
export async function ensureTradingKey(wallet: string): Promise<`0x${string}`> {
  const existing = loadAccount(wallet);
  let key = readSecret(wallet, 'key.json');
  if (!key && existing) {
    throw new CliError({
      code: 'not_set_up',
      message: `The trading key for '${wallet}' is missing; the recorded Polymarket wallet ${existing.wallet} can't be controlled.`,
      hint: 'Restore the key file, or use a different --wallet name.'
    });
  }
  if (!key) {
    const { generatePrivateKey } = await import('viem/accounts');
    key = generatePrivateKey();
    writeSecret(wallet, 'key.json', key);
  }
  return key as `0x${string}`;
}

export function hasLocalKey(wallet: string): boolean {
  return fs.existsSync(accountFile(wallet, 'key.json'));
}

// Records which OMS wallet holds the imported copy of the trading key. No secret.
// `kind` is absent on records written before it was added.
export type BackupRecord = { omsWalletId: string; address: string; at: string; kind?: AccountKind };

export function readBackup(wallet: string): BackupRecord | null {
  return (readJsonFile(accountFile(wallet, 'backup.json')) as BackupRecord | undefined) ?? null;
}

export function writeBackup(wallet: string, b: BackupRecord): void {
  writeJsonFile({ file: path.join(accountDir(wallet), 'backup.json'), data: b });
}

export async function setupAccount(
  wallet: string
): Promise<{ account: StoredAccount; created: boolean; approvalsSet: boolean }> {
  const existing = loadAccount(wallet);
  const { privateKeyToAccount } = await import('viem/accounts');

  const key = await ensureTradingKey(wallet);
  const signer = privateKeyToAccount(key).address;

  if (!readSecret(wallet, 'builder.json')) await mintBuilderKey(wallet, key, signer);

  // Creating the client deploys the deposit wallet through the relayer when needed.
  const client = await clientFor(wallet, existing ?? { kind: 'deposit-wallet' }, key);
  const account: StoredAccount = existing ?? {
    kind: 'deposit-wallet',
    signer,
    wallet: client.account.wallet,
    createdAt: new Date().toISOString()
  };
  if (!existing)
    writeJsonFile({ file: path.join(accountDir(wallet), 'account.json'), data: account });

  return { account, created: !existing, approvalsSet: await runApprovals(client) };
}

// Sets any missing trading approvals (the SDK's and the legacy NegRiskAdapter's).
// Returns whether it set anything.
async function runApprovals(client: SecureClient): Promise<boolean> {
  let approvalsSet = false;
  try {
    const state = await client.fetchTradingApprovalsState();
    if (!state.isFullyApproved) {
      await client.setupTradingApprovals();
      approvalsSet = true;
    }
  } catch (err) {
    throw mapSdkError(err);
  }
  if (await ensureLegacyNegRiskApprovals(client)) approvalsSet = true;
  if (approvalsSet) {
    // The CLOB caches allowances; ask it to re-read them.
    const { root, actions } = await loadSdk();
    try {
      await actions.updateBalanceAllowance(client, {
        assetType: root.AssetType.COLLATERAL
      } as never);
    } catch (err) {
      throw mapSdkError(err);
    }
  }
  return approvalsSet;
}

// Legacy: an imported Polymarket key whose funds sit in a Polymarket proxy wallet.
// The import stands even if the builder key can't be minted; withdraw needs it,
// and `setup` mints it later.
export async function importLegacyKey(
  wallet: string,
  privateKey: string
): Promise<{ account: StoredAccount; builderKey: boolean; warning?: string }> {
  const dir = accountDir(wallet);
  if (fs.existsSync(path.join(dir, 'key.json')) || fs.existsSync(path.join(dir, 'account.json'))) {
    throw new CliError({
      code: 'invalid_input',
      message: `A Polymarket account already exists for '${wallet}'; importing a key would overwrite its only key.`,
      hint: 'Withdraw first, or use a different --wallet name.'
    });
  }
  const { getPolymarketProxyWalletAddress } = await import('./gamma.ts');
  const { privateKeyToAccount } = await import('viem/accounts');
  const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new CliError({
      code: 'invalid_input',
      message: 'The private key must be 32 bytes of hex.'
    });
  }
  const signer = privateKeyToAccount(pk as `0x${string}`).address;
  const account: StoredAccount = {
    kind: 'legacy-proxy',
    signer,
    wallet: await getPolymarketProxyWalletAddress(signer),
    createdAt: new Date().toISOString()
  };
  // Credentials from any earlier signer must not be paired with the imported key.
  fs.rmSync(path.join(dir, 'builder.json'), { force: true });
  fs.rmSync(path.join(dir, 'clob.json'), { force: true });
  writeSecret(wallet, 'key.json', pk);
  writeJsonFile({ file: path.join(dir, 'account.json'), data: account });
  try {
    await mintBuilderKey(wallet, pk, signer);
    return { account, builderKey: true };
  } catch (err) {
    const reason = (err as Error)?.message ?? String(err);
    return {
      account,
      builderKey: false,
      warning: `Couldn't mint a Polymarket builder key (${reason}). withdraw needs one: run agent polymarket setup --wallet ${wallet} --broadcast to mint it before withdrawing.`
    };
  }
}

// Refreshes the CLOB's cached view first: a plain fetch can lag a deposit or a fill.
export async function pusdBalance(wallet: string): Promise<bigint> {
  return pusdBalanceOf(await getTradingClient(wallet));
}

// Records of an account whose key was lost, kept beside the new account.
export const PREVIOUS_PREFIX = 'previous-';

const sameAddress = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

// Moves everything in polymarket/<wallet>/ except earlier archives into a new
// previous-<timestamp>/ folder. On a wiped machine there may be nothing to move, so
// the old account's identity is written there from what recovery learned.
function archiveAccount(wallet: string, old: { account: StoredAccount; backup: BackupRecord }) {
  const dir = accountDir(wallet);
  const name = `${PREVIOUS_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const dest = path.join(dir, name);
  fs.mkdirSync(dest, { mode: 0o700 });
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith(PREVIOUS_PREFIX)) continue;
    fs.renameSync(path.join(dir, entry), path.join(dest, entry));
  }
  if (!fs.existsSync(path.join(dest, 'account.json')))
    writeJsonFile({ file: path.join(dest, 'account.json'), data: old.account });
  if (!fs.existsSync(path.join(dest, 'backup.json')))
    writeJsonFile({ file: path.join(dest, 'backup.json'), data: old.backup });
  return name;
}

export type RecoveryResult = {
  backedUp: boolean;
  omsWalletId?: string;
  created?: boolean;
  recovered?: Record<string, unknown>;
  pendingDeposit?: Record<string, unknown>;
  legacyProxy?: { address: string; balances: { pusd: string; usdcE: string } };
  error?: string;
  hint?: string;
};

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const ERC20_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  }
] as const;

// The pUSD and USDC.e held by the legacy Polymarket proxy wallet that belongs to `signer`.
async function legacyProxyBalances(signer: string): Promise<{
  address: string;
  funded: boolean;
  balances: { pusd: string; usdcE: string };
}> {
  const address = await getPolymarketProxyWalletAddress(signer);
  const chain = await polygonReader();
  const read = (token: string) =>
    chain.readContract({
      address: token as `0x${string}`,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [address as `0x${string}`]
    });
  try {
    const [pusd, usdcE] = await Promise.all([read(PUSD), read(USDC_E)]);
    return {
      address,
      funded: pusd > 0n || usdcE > 0n,
      balances: { pusd: formatUnits6(pusd), usdcE: formatUnits6(usdcE) }
    };
  } catch (err) {
    throw mapChainReadError(err, 'the legacy proxy wallet balances');
  }
}

type KeyAccount = { kind: AccountKind; wallet?: string };

// What the local records say about the account `target` controls, if they describe it.
function recordedAccount(
  wallet: string,
  target: { address: string }
): { local: StoredAccount | null; kind?: AccountKind } {
  const acct = loadAccount(wallet);
  const local = acct && sameAddress(acct.signer, target.address) ? acct : null;
  const backup = readBackup(wallet);
  const kind =
    local?.kind ??
    (backup && sameAddress(backup.address, target.address) ? backup.kind : undefined);
  return { local, kind };
}

async function keyAccount(
  target: { address: string },
  local: StoredAccount | null,
  kind: AccountKind
): Promise<KeyAccount> {
  if (kind !== 'legacy-proxy') return { kind };
  return {
    kind,
    wallet: local?.wallet ?? (await getPolymarketProxyWalletAddress(target.address))
  };
}

// Builds a client for the account a key held in OMS controls, signing through OMS. Uses the
// local builder key when the local records belong to this key, otherwise mints one as the
// EOA (as setup does). Writes nothing to disk; `minted` says whether the builder key is new.
async function omsKeyClient(p: {
  wallet: string;
  owner: OmsWalletLike;
  target: { id: string; address: string };
  local: StoredAccount | null;
  acct: KeyAccount;
}): Promise<{ client: SecureClient; builder: Creds; minted: boolean }> {
  const signer = omsSigner(p.owner, { walletId: p.target.id, address: p.target.address });
  const stored = p.local ? readCreds(p.wallet, 'builder.json') : null;
  const builder = stored ?? (await mintBuilderCreds(signer, p.target.address));
  const client = await createClient({
    signer,
    acct: p.acct,
    builder,
    clob: p.local ? readCreds(p.wallet, 'clob.json') : null
  });
  return { client, builder, minted: !stored };
}

// Owner mode, local key missing, OMS holds the key: rebuilds the account's local records
// (account.json, backup.json, builder key) and sets any missing approvals, all signed
// through OMS. Never creates a key.
export async function restoreFromOms(p: {
  wallet: string;
  owner: OmsWalletLike;
  target: { id: string; address: string };
}): Promise<{ account: StoredAccount; approvalsSet: boolean; backup: BackupRecord }> {
  const { wallet, owner, target } = p;
  const { local, kind: recordedKind } = recordedAccount(wallet, target);
  if (loadAccount(wallet) && !local) {
    throw new CliError({
      code: 'invalid_input',
      message: `The recorded Polymarket account for '${wallet}' belongs to a different key than OMS holds.`
    });
  }
  let kind = recordedKind;
  if (!kind) {
    // Unknown kind: an imported legacy key keeps its funds in its proxy wallet.
    kind = (await legacyProxyBalances(target.address)).funded ? 'legacy-proxy' : 'deposit-wallet';
  }
  const acct = await keyAccount(target, local, kind);
  const { client, builder, minted } = await omsKeyClient({ wallet, owner, target, local, acct });
  const walletAddress = (acct.wallet ?? client.account.wallet) as string;
  if (local && !sameAddress(local.wallet, walletAddress)) {
    throw new CliError({
      code: 'upstream_error',
      message: `The backed-up key controls ${walletAddress}, not the recorded Polymarket wallet ${local.wallet}.`
    });
  }
  if (minted) writeSecret(wallet, 'builder.json', JSON.stringify(builder));
  // Without local records, leftover credentials may belong to another signer: replace them.
  if ((!local || !readSecret(wallet, 'clob.json')) && client.credentials)
    writeSecret(wallet, 'clob.json', JSON.stringify(client.credentials));
  const account: StoredAccount = local ?? {
    kind,
    signer: target.address,
    wallet: walletAddress,
    createdAt: new Date().toISOString()
  };
  if (!local) writeJsonFile({ file: path.join(accountDir(wallet), 'account.json'), data: account });
  const backup: BackupRecord = {
    omsWalletId: target.id,
    address: target.address,
    at: new Date().toISOString(),
    kind
  };
  writeBackup(wallet, backup);
  return { account, approvalsSet: await runApprovals(client), backup };
}

// Every trading-key address this machine still uses or knows of as current, across all
// wallet names (account.json, backup.json, key.json). Archived accounts are not included.
export function localTradingKeyAddresses(): Set<string> {
  const out = new Set<string>();
  const root = path.join(STORAGE_ROOT, 'polymarket');
  if (!fs.existsSync(root)) return out;
  for (const name of fs.readdirSync(root)) {
    const acct = loadAccount(name);
    if (acct?.signer) out.add(acct.signer.toLowerCase());
    const backup = readBackup(name);
    if (backup?.address) out.add(backup.address.toLowerCase());
    const key = readSecret(name, 'key.json');
    if (key) out.add(privateKeyToAccount(key as `0x${string}`).address.toLowerCase());
  }
  return out;
}

// The trading keys this install used before for `wallet`: the signers and backup addresses
// recorded in its archived previous-* folders. Never another install's keys.
export function previousTradingKeyAddresses(wallet: string): string[] {
  const dir = accountFile(wallet, '');
  if (!fs.existsSync(dir)) return [];
  const out = new Map<string, string>();
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(PREVIOUS_PREFIX)) continue;
    const acct = readJsonFile(path.join(dir, name, 'account.json')) as StoredAccount | undefined;
    const backup = readJsonFile(path.join(dir, name, 'backup.json')) as BackupRecord | undefined;
    for (const address of [acct?.signer, backup?.address]) {
      if (address) out.set(address.toLowerCase(), address);
    }
  }
  return [...out.values()];
}

// The SDK only refuses this way when the derived Deposit Wallet was never deployed.
const NOT_DEPLOYED = /Deposit Wallet deployment requires/;

// Sweeps the pUSD of the Deposit Wallet an older trading key controls to `mainAddress`.
// Returns null when there is nothing to sweep (no deployed wallet, or 0 pUSD): then the
// only calls made are the client creation and the balance read.
export async function sweepOldKey(p: {
  owner: OmsWalletLike;
  target: { id: string; address: string };
  mainAddress: string;
}): Promise<{ withdrawnUsd: string; txHash: string | null } | null> {
  const signer = omsSigner(p.owner, { walletId: p.target.id, address: p.target.address });
  const acct: KeyAccount = { kind: 'deposit-wallet' };
  let probe: SecureClient;
  try {
    probe = await createClient({ signer, acct, builder: null, clob: null });
  } catch (err) {
    if (NOT_DEPLOYED.test(errorText(err))) return null;
    throw err;
  }
  if ((await pusdBalanceOf(probe)) === 0n) return null;
  const builder = await mintBuilderCreds(signer, p.target.address);
  const client = await createClient({
    signer,
    acct,
    builder,
    clob: (probe.credentials as Creds | undefined) ?? null
  });
  const res = await withdrawAll({
    client,
    account: client.account.wallet as string,
    recipient: p.mainAddress,
    broadcast: true
  });
  return { withdrawnUsd: formatUnits6(res.amount), txHash: res.txHash ?? null };
}

// An earlier deposit to the old account that the bridge hasn't finished. Entries beyond
// the recorded baseline belong to it; COMPLETED or FAILED means it is over.
async function unsettledDeposit(wallet: string): Promise<PendingDeposit | null> {
  const pending = loadPending(wallet);
  if (!pending) return null;
  const { transactions } = await bridgeStatus(pending.bridgeAddress);
  const fresh = transactions.slice(
    0,
    Math.max(0, transactions.length - (pending.baselineCount ?? transactions.length))
  );
  return fresh.some((t) => t.status === 'COMPLETED' || t.status === 'FAILED') ? null : pending;
}

const RETRY_HINT = 'The next owner sign-in retries the recovery.';

// Session-mode recovery, run during a confirmed owner request when the local trading key is
// gone but OMS holds it (`target`). Sweeps the old account's pUSD to `mainAddress`, archives
// the old records, then creates and backs up a new key. If anything fails before the sweep
// completes, nothing on disk changes and no new key is created. The key is never replaced
// while a deposit to the old account is in flight, or while funds sit in a legacy proxy.
export async function recoverAccount(p: {
  wallet: string;
  owner: OmsWalletLike;
  mainAddress: string;
  target: { id: string; address: string };
}): Promise<RecoveryResult> {
  const { wallet, owner, mainAddress, target } = p;
  const { local, kind: recordedKind } = recordedAccount(wallet, target);
  let client: SecureClient;
  let kind: AccountKind;
  let withdrawnUsd = '0';
  let txHash: string | null = null;
  try {
    if (recordedKind) {
      kind = recordedKind;
    } else {
      // Unknown kind: never rotate away from a funded legacy proxy, and never derive (and so
      // deploy) a Deposit Wallet for a key whose funds live in one.
      const legacy = await legacyProxyBalances(target.address);
      if (legacy.funded) {
        return {
          backedUp: false,
          omsWalletId: target.id,
          legacyProxy: { address: legacy.address, balances: legacy.balances },
          error:
            'The backed-up key controls a funded legacy Polymarket proxy wallet; the key was not replaced.',
          hint: 'Sign in with agent wallet login to use it through OMS.'
        };
      }
      kind = 'deposit-wallet';
    }
    const acct = await keyAccount(target, local, kind);
    ({ client } = await omsKeyClient({ wallet, owner, target, local, acct }));
    const oldWallet = (acct.wallet ?? client.account.wallet) as string;
    if (local && !sameAddress(local.wallet, oldWallet)) {
      throw new CliError({
        code: 'upstream_error',
        message: `The backed-up key controls ${oldWallet}, not the recorded Polymarket wallet ${local.wallet}.`
      });
    }
    if ((await pusdBalanceOf(client)) > 0n) {
      const res = await withdrawAll({
        client,
        account: oldWallet,
        recipient: mainAddress,
        broadcast: true
      });
      withdrawnUsd = formatUnits6(res.amount);
      txHash = res.txHash ?? null;
    }
  } catch (error) {
    return { backedUp: false, omsWalletId: target.id, error: errorText(error) };
  }

  const previousAccount = client.account.wallet as string;
  const recovered: Record<string, unknown> = { withdrawnUsd, txHash, previousAccount };
  // The money has moved; from here a failure is reported alongside what was recovered.
  try {
    const page = await client.listPositions({ status: 'OPEN' }).firstPage();
    recovered.positionsLeft = (page.items as Array<Record<string, unknown>>).map((x) => ({
      title: x.title,
      outcome: x.outcome,
      conditionId: x.conditionId,
      shares: x.currentSize,
      valueUsd: x.currentValue
    }));
    if (page.hasMore) recovered.positionsTruncated = true;
  } catch (error) {
    recovered.positionsLeft = null;
    recovered.positionsError = errorText(mapSdkError(error));
  }

  try {
    const pending = await unsettledDeposit(wallet);
    if (pending) {
      return {
        backedUp: false,
        omsWalletId: target.id,
        recovered,
        pendingDeposit: {
          amountUsd: formatUnits6(pending.amountUnits),
          txHash: pending.txHash,
          sentAt: pending.sentAt
        },
        error:
          'An earlier deposit to the old account is still being credited; the key was not replaced.',
        hint: `Retry after it settles. ${RETRY_HINT}`
      };
    }
    if (kind === 'legacy-proxy') {
      // withdraw moves only pUSD: USDC.e left in the proxy keeps the old key in use.
      const legacy = await legacyProxyBalances(target.address);
      if (legacy.funded) {
        return {
          backedUp: false,
          omsWalletId: target.id,
          recovered,
          legacyProxy: { address: legacy.address, balances: legacy.balances },
          error: 'Funds remain in the legacy Polymarket proxy wallet; the key was not replaced.',
          hint: 'Sign in with agent wallet login to use it through OMS.'
        };
      }
    }
  } catch (error) {
    return {
      backedUp: false,
      omsWalletId: target.id,
      recovered,
      error: errorText(error),
      hint: RETRY_HINT
    };
  }

  try {
    recovered.previousRecords = archiveAccount(wallet, {
      account: local ?? {
        kind,
        signer: target.address,
        wallet: previousAccount,
        createdAt: new Date().toISOString()
      },
      backup: {
        omsWalletId: target.id,
        address: target.address,
        at: new Date().toISOString(),
        kind
      }
    });
    const key = await ensureTradingKey(wallet);
    const res = await backupTradingKey(owner, key, installTradingKeyReference());
    writeBackup(wallet, {
      omsWalletId: res.omsWalletId,
      address: res.address,
      at: new Date().toISOString(),
      kind: 'deposit-wallet'
    });
    return { backedUp: true, omsWalletId: res.omsWalletId, created: true, recovered };
  } catch (error) {
    return { backedUp: false, recovered, error: errorText(error) };
  }
}

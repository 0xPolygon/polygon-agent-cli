// The Polymarket trading account for an OMS wallet name: a CLI-generated key
// that controls a Polymarket Deposit Wallet. Polymarket's relayer deploys the
// wallet and runs its approvals and transfers, authorized by a builder API key
// minted from the same key. The OMS wallet never signs for Polymarket.

import fs from 'node:fs';
import path from 'node:path';

import type { CipherData } from '../storage.ts';

import { CliError } from '../errors.ts';
import { readJsonFile, writeJsonFile } from '../session/state.ts';
import { decrypt, encrypt, STORAGE_ROOT } from '../storage.ts';
import { CTF, LEGACY_NEG_RISK_ADAPTER, PUSD } from './gamma.ts';
import { loadSdk, mapSdkError } from './sdk.ts';

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

function readSecret(wallet: string, name: string): string | null {
  const data = readJsonFile(path.join(accountDir(wallet), name)) as CipherData | undefined;
  return data ? decrypt(data) : null;
}

function writeSecret(wallet: string, name: string, value: string): void {
  writeJsonFile({ file: path.join(accountDir(wallet), name), data: encrypt(value) });
}

export function loadAccount(wallet: string): StoredAccount | null {
  return (readJsonFile(path.join(accountDir(wallet), 'account.json')) as StoredAccount) ?? null;
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

async function clientFor(
  wallet: string,
  acct: { kind: AccountKind; wallet?: string },
  key: string
): Promise<SecureClient> {
  const { root, viem, node } = await loadSdk();
  const builderText = readSecret(wallet, 'builder.json');
  const clobText = readSecret(wallet, 'clob.json');
  try {
    const client = await root.createSecureClient({
      signer: viem.privateKey(key),
      ...(acct.kind === 'legacy-proxy' ? { wallet: acct.wallet } : {}),
      ...(builderText ? { apiKey: node.builderApiKey(JSON.parse(builderText) as Creds) } : {}),
      ...(clobText ? { credentials: JSON.parse(clobText) as Creds } : {})
    } as never);
    if (!clobText && client.credentials)
      writeSecret(wallet, 'clob.json', JSON.stringify(client.credentials));
    return client;
  } catch (err) {
    throw mapSdkError(err);
  }
}

export async function getTradingClient(wallet: string): Promise<SecureClient> {
  const acct = requireAccount(wallet);
  const key = readSecret(wallet, 'key.json');
  if (!key) throw missingKeyError(wallet);
  return clientFor(wallet, acct, key);
}

// The builder key authorizes gasless relayer calls (approvals, transfers). It is
// minted as the EOA itself; no deposit wallet is needed for that.
async function mintBuilderKey(wallet: string, key: string, signer: string): Promise<void> {
  const { root, viem, actions } = await loadSdk();
  try {
    const eoaClient = await root.createSecureClient({
      signer: viem.privateKey(key),
      wallet: signer
    } as never);
    const creds = await actions.createBuilderApiKey(eoaClient as never);
    writeSecret(wallet, 'builder.json', JSON.stringify(creds));
  } catch (err) {
    throw mapSdkError(err);
  }
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

async function readLegacyNegRiskApprovals(
  client: SecureClient
): Promise<{ pusd: boolean; ctf: boolean }> {
  const { createPublicClient, http } = await import('viem');
  const { polygon } = await import('viem/chains');
  const chain = createPublicClient({ chain: polygon, transport: http() });
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
    throw mapSdkError(err);
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

export async function setupAccount(
  wallet: string
): Promise<{ account: StoredAccount; created: boolean; approvalsSet: boolean }> {
  const existing = loadAccount(wallet);
  const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');

  let key = readSecret(wallet, 'key.json');
  if (!key && existing) {
    throw new CliError({
      code: 'not_set_up',
      message: `The trading key for '${wallet}' is missing; the recorded Polymarket wallet ${existing.wallet} can't be controlled.`,
      hint: 'Restore the key file, or use a different --wallet name.'
    });
  }
  if (!key) {
    key = generatePrivateKey();
    writeSecret(wallet, 'key.json', key);
  }
  const signer = privateKeyToAccount(key as `0x${string}`).address;

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
  return { account, created: !existing, approvalsSet };
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
  const client = await getTradingClient(wallet);
  const { root, actions } = await loadSdk();
  try {
    const res = await actions.updateBalanceAllowance(client, {
      assetType: root.AssetType.COLLATERAL
    } as never);
    return BigInt(res.balance);
  } catch (err) {
    throw mapSdkError(err);
  }
}

// Earning on stablecoins: ERC-4626 vaults (Morpho) that Trails' Yield API
// lists, on Katana and Polygon, as on the dashboard. The connection's key only
// transfers tokens, so a deposit goes through Trails: the key pays an intent,
// and Trails' executor (intent protocol v1.5) approves the vault, deposits the
// amount for the wallet, and sweeps anything left back to the wallet.
// Withdrawing is a call from the wallet itself, so it's the owner's: the agent
// asks, the owner approves on the site, and it runs as the owner.

import type { Address } from 'viem';

import { encodeMulticallHydrateExecute, HYDRATE_PROXY_ADDRESS } from '0xtrails/hydrate';
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  erc4626Abi,
  formatUnits,
  getAddress,
  http,
  isAddress
} from 'viem';
import { katana, polygon } from 'viem/chains';

import { MoneyError } from './errors.ts';
import { chainLabel, findSupportedToken, parseChain } from './tokens.ts';
import { tokenUnits } from './trade.ts';

const TRAILS = 'https://trails-api.sequence.app/rpc/Trails';
export const EARN_CHAINS = [747474, 137];
const CHAINS = { 747474: katana, 137: polygon } as const;
const MIN_TVL_USD = 10_000;

export interface Vault {
  chainId: number;
  chain: string;
  address: Address;
  name: string;
  asset: { symbol: string; address: Address; decimals: number };
  apy: number;
  tvlUsd: number;
}

interface RawMarket {
  id: string;
  metadata?: { name?: string; deprecated?: boolean; underMaintenance?: boolean };
  inputTokens?: { symbol: string; decimals: number; address?: string }[];
  outputToken?: { address?: string };
  rewardRate?: { total: number };
  statistics?: { tvlUsd?: string };
  status?: { enter: boolean };
}

export interface EarnDeps {
  trailsKey: string;
  fetch?: typeof fetch;
  rpcUrl?: (chainId: number) => string | undefined;
  // Reads from a vault (viem in production).
  read?: (p: {
    chainId: number;
    address: Address;
    fn: string;
    args: unknown[];
  }) => Promise<unknown>;
}

function chainArg(chain: string | undefined): number[] {
  if (!chain) return EARN_CHAINS;
  const id = parseChain(chain);
  if (id === undefined || !EARN_CHAINS.includes(id)) {
    throw new MoneyError({
      code: 'invalid_input',
      message: `Earn vaults are on ${EARN_CHAINS.map(chainLabel).join(' and ')}.`
    });
  }
  return [id];
}

function reader(deps: EarnDeps) {
  if (deps.read) return deps.read;
  return ({ chainId, address, fn, args }: Parameters<NonNullable<EarnDeps['read']>>[0]) =>
    createPublicClient({
      chain: CHAINS[chainId as 747474 | 137],
      transport: http(deps.rpcUrl?.(chainId))
    }).readContract({
      address,
      abi: [...erc4626Abi, ...erc20Abi],
      functionName: fn as never,
      args: args as never
    });
}

/** The open stablecoin vaults, biggest first. */
export async function listVaults(chain: string | undefined, deps: EarnDeps): Promise<Vault[]> {
  const doFetch = deps.fetch ?? fetch;
  const lists = await Promise.all(
    chainArg(chain).map(async (chainId) => {
      const res = await doFetch(`${TRAILS}/YieldGetMarkets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(deps.trailsKey ? { 'X-Access-Key': deps.trailsKey } : {})
        },
        body: JSON.stringify({ provider: 'morpho', chainId: String(chainId), limit: 100 })
      });
      if (!res.ok) {
        throw new MoneyError({
          code: 'upstream_unavailable',
          message: "Trails didn't list the vaults just now. Try again shortly."
        });
      }
      const items = ((await res.json()) as { items?: RawMarket[] }).items ?? [];
      return items.flatMap((m): Vault[] => {
        const input = m.inputTokens?.[0];
        const out = m.outputToken?.address;
        const covered = input?.address && findSupportedToken({ chainId, address: input.address });
        const tvlUsd = Number(m.statistics?.tvlUsd ?? 0);
        if (
          !m.status?.enter ||
          m.metadata?.deprecated ||
          m.metadata?.underMaintenance ||
          !out ||
          !isAddress(out) ||
          !covered ||
          covered.kind !== 'usd' ||
          tvlUsd < MIN_TVL_USD
        ) {
          return [];
        }
        return [
          {
            chainId,
            chain: chainLabel(chainId),
            address: getAddress(out),
            name: m.metadata?.name ?? `${covered.symbol} vault`,
            asset: { symbol: covered.symbol, address: covered.address, decimals: covered.decimals },
            apy: Math.round((m.rewardRate?.total ?? 0) * 10_000) / 100,
            tvlUsd: Math.round(tvlUsd)
          }
        ];
      });
    })
  );
  return lists.flat().sort((a, b) => b.tvlUsd - a.tvlUsd);
}

/** The vaults that take deposits from the wallet now (Trails also lists full or closed ones). */
export async function openVaults(
  vaults: Vault[],
  wallet: Address,
  deps: EarnDeps
): Promise<Vault[]> {
  const read = reader(deps);
  const open = await Promise.all(
    vaults.map(async (v) => {
      const room = (await read({
        chainId: v.chainId,
        address: v.address,
        fn: 'maxDeposit',
        args: [wallet]
      }).catch(() => 0n)) as bigint;
      return room > 0n;
    })
  );
  return vaults.filter((_, i) => open[i]);
}

/** What the wallet holds in each vault, in its stablecoin. */
export async function positions(
  vaults: Vault[],
  wallet: Address,
  deps: EarnDeps
): Promise<{ vault: Address; chain: string; amount: string; symbol: string }[]> {
  const read = reader(deps);
  const rows = await Promise.all(
    vaults.map(async (v) => {
      const shares = (await read({
        chainId: v.chainId,
        address: v.address,
        fn: 'balanceOf',
        args: [wallet]
      }).catch(() => 0n)) as bigint;
      if (shares === 0n) return null;
      const assets = (await read({
        chainId: v.chainId,
        address: v.address,
        fn: 'convertToAssets',
        args: [shares]
      })) as bigint;
      return {
        vault: v.address,
        chain: v.chain,
        amount: formatUnits(assets, v.asset.decimals),
        symbol: v.asset.symbol
      };
    })
  );
  return rows.filter((r) => r !== null);
}

export interface OwnerTxs {
  chainId: number;
  transactions: { to: Address; data: `0x${string}` }[];
}

async function findVault(
  params: { vault: string; chain?: string },
  deps: EarnDeps
): Promise<Vault> {
  if (!isAddress(params.vault)) {
    throw new MoneyError({
      code: 'invalid_input',
      message: `Not a vault address: ${params.vault}`
    });
  }
  const vault = (await listVaults(params.chain, deps)).find(
    (v) => v.address.toLowerCase() === params.vault.toLowerCase()
  );
  if (!vault) {
    throw new MoneyError({
      code: 'not_covered',
      message: "That isn't one of the open vaults earn_vaults lists.",
      hint: 'Pick a vault from earn_vaults.'
    });
  }
  // The vault's own word on what it takes.
  const asset = (await reader(deps)({
    chainId: vault.chainId,
    address: vault.address,
    fn: 'asset',
    args: []
  })) as string;
  if (asset.toLowerCase() !== vault.asset.address.toLowerCase()) {
    throw new MoneyError({
      code: 'upstream_error',
      message: "The vault's token doesn't match what Trails lists for it; not using it."
    });
  }
  return vault;
}

/**
 * The executor call that deposits what Trails delivers into the vault for the
 * wallet: `amount` of its stablecoin, the exact output asked of Trails.
 */
export async function depositCall(
  params: { vault: string; amount: string; chain?: string; wallet: Address },
  deps: EarnDeps
): Promise<{ vault: Vault; amount: string; call: { to: Address; data: `0x${string}` } }> {
  const vault = await findVault(params, deps);
  // The exact amount, as Trails delivers exactly that (its runtime-balance
  // placeholder would also take the intent's fee, and the call would revert).
  const units = tokenUnits(params.amount, vault.asset.decimals);
  // Trails lists vaults that are full or closed; the vault's own word decides.
  const room = (await reader(deps)({
    chainId: vault.chainId,
    address: vault.address,
    fn: 'maxDeposit',
    args: [params.wallet]
  })) as bigint;
  if (room < units) {
    throw new MoneyError({
      code: 'not_covered',
      message:
        room === 0n
          ? `${vault.name} isn't taking deposits right now.`
          : `${vault.name} takes at most ${formatUnits(room, vault.asset.decimals)} ${vault.asset.symbol} right now.`,
      hint: 'Pick another vault from earn_vaults.'
    });
  }
  return {
    vault,
    amount: params.amount,
    call: {
      to: HYDRATE_PROXY_ADDRESS,
      data: encodeMulticallHydrateExecute({
        calls: [
          {
            to: vault.asset.address,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [vault.address, units]
            })
          },
          {
            to: vault.address,
            data: encodeFunctionData({
              abi: erc4626Abi,
              functionName: 'deposit',
              args: [units, params.wallet]
            })
          }
        ],
        token: vault.asset.address,
        sweepTarget: params.wallet
      })
    }
  };
}

/** Withdraw `amount` of the stablecoin (or `all`) back to the wallet, as the owner. */
export async function withdrawTxs(
  params: { vault: string; amount: string; chain?: string; wallet: Address },
  deps: EarnDeps
): Promise<{ vault: Vault; txs: OwnerTxs; amount: string }> {
  const vault = await findVault(params, deps);
  const read = reader(deps);
  const shares = (await read({
    chainId: vault.chainId,
    address: vault.address,
    fn: 'balanceOf',
    args: [params.wallet]
  })) as bigint;
  if (shares === 0n) {
    throw new MoneyError({
      code: 'insufficient_balance',
      message: 'Nothing is deposited in that vault.'
    });
  }
  const all = /^(all|max)$/i.test(params.amount.trim());
  let data: `0x${string}`;
  let amount: string;
  if (all) {
    const assets = (await read({
      chainId: vault.chainId,
      address: vault.address,
      fn: 'convertToAssets',
      args: [shares]
    })) as bigint;
    amount = formatUnits(assets, vault.asset.decimals);
    data = encodeFunctionData({
      abi: erc4626Abi,
      functionName: 'redeem',
      args: [shares, params.wallet, params.wallet]
    });
  } else {
    const units = tokenUnits(params.amount, vault.asset.decimals);
    const needed = (await read({
      chainId: vault.chainId,
      address: vault.address,
      fn: 'convertToShares',
      args: [units]
    })) as bigint;
    if (needed > shares) {
      throw new MoneyError({
        code: 'insufficient_balance',
        message: `That's more than the wallet has in the vault.`,
        hint: 'Use "all" to take everything out.'
      });
    }
    amount = params.amount;
    data = encodeFunctionData({
      abi: erc4626Abi,
      functionName: 'withdraw',
      args: [units, params.wallet, params.wallet]
    });
  }
  return {
    vault,
    amount,
    txs: { chainId: vault.chainId, transactions: [{ to: vault.address, data }] }
  };
}

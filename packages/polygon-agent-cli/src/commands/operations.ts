import type { SelectPaymentRequirements } from '@x402/core/client';
import type { CommandModule, Argv } from 'yargs';

import React from 'react';
import { encodeFunctionData, erc20Abi, getAddress, isAddress } from 'viem';

import type { ContractTokenBalance } from '@polygonlabs/oms-wallet';

import { findNetworkById } from '@polygonlabs/oms-wallet';

import type { TradeRecord } from '../lib/trade/state.ts';

import { ensureBuilderAccess } from '../lib/builder-provision.ts';
import { bigintReplacer, CliError, failureJson } from '../lib/errors.ts';
import { isWalletFunded } from '../lib/indexer.ts';
import { resolveBroadcast, withWriteFlags } from '../lib/mode.ts';
import { getOmsClient, loginUiBaseUrl } from '../lib/oms-client.ts';
import { checkSessionSpend } from '../lib/session/run-tx.ts';
import { findSupportedToken } from '../lib/session/tokens.ts';
import { listTransfers } from '../lib/session/transfer.ts';
import { loadOmsWalletPointer, loadBuilderConfig } from '../lib/storage.ts';
import { resolveErc20BySymbol } from '../lib/token-directory.ts';
import { getTokenConfig } from '../lib/tokens.ts';
import { DEFAULT_TRADE_TIMEOUT_MS, executeSwap } from '../lib/trade/execute.ts';
import { describeTrade, quoteSwap } from '../lib/trade/quote.ts';
import { loadTrade } from '../lib/trade/state.ts';
import { runTx as runDappClientTx } from '../lib/tx-dispatch.ts';
import {
  resolveNetwork,
  formatUnits,
  parseUnits,
  getExplorerUrl,
  getReadRpcUrl,
  fileCoerce
} from '../lib/utils.ts';
import {
  isBazaarBody,
  parseBazaarPayment,
  markAuthorizationPending,
  pendingAuthorizations,
  readTokenBalance,
  releaseX402Reservation,
  reserveX402Payment,
  settleAuthorizationPending,
  signedAuthorization,
  withX402Lock,
  waitForSignerFunds,
  x402PriceUsd,
  x402UsdText
} from '../lib/x402-guard.ts';
import { isTTY, inkRender } from '../ui/render.js';
import { BalancesUI, FundUI, SendUI } from './operations-ui.js';

// Shared options
function withWalletAndChain<T>(yargs: Argv<T>) {
  return yargs
    .option('wallet', {
      type: 'string' as const,
      default: 'main',
      describe: 'Wallet name'
    })
    .option('chain', {
      type: 'string' as const,
      describe: 'Chain name or ID'
    });
}

const BALANCES_MAX_CHAINS = 20;

function parseCommaChainList(chainsArg: string | undefined): string[] {
  if (!chainsArg || typeof chainsArg !== 'string') return [];
  return chainsArg
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

type BalanceRowJson =
  | { type: 'native'; symbol: string; balance: string }
  | {
      type: 'erc20';
      symbol: string;
      name?: string;
      contractAddress: string;
      balance: string;
    };

async function fetchBalancesRowsForChain(
  walletName: string,
  walletAddress: string,
  chainSpec: string
): Promise<{ chainId: number; chain: string; balances: BalanceRowJson[] }> {
  const network = resolveNetwork(chainSpec);
  const nativeDecimals = network.nativeToken?.decimals ?? 18;
  const nativeSymbol = network.nativeToken?.symbol || 'POL';

  const omsNetwork = findNetworkById(network.chainId);
  if (!omsNetwork) throw new Error(`Unsupported chain for OMS indexer: ${network.chainId}`);
  const oms = getOmsClient(walletName);

  // SDK 0.1.0-alpha.4 unified the two indexer calls into getBalances, returning
  // { nativeBalances, balances } for the requested network(s).
  const res = await oms.indexer.getBalances({
    walletAddress,
    networks: [omsNetwork],
    includeMetadata: true
  });

  const nativeWei = res.nativeBalances?.[0]?.balance || '0';
  const native: BalanceRowJson[] = [
    {
      type: 'native',
      symbol: nativeSymbol,
      balance: formatUnits(BigInt(nativeWei), nativeDecimals)
    }
  ];

  const erc20: BalanceRowJson[] = (res.balances || [])
    .filter((b: ContractTokenBalance) => !!b.contractAddress)
    .map((b: ContractTokenBalance) => ({
      type: 'erc20' as const,
      symbol: b.contractInfo?.symbol || 'ERC20',
      name: b.contractInfo?.name || undefined,
      contractAddress: b.contractAddress as string,
      balance: formatUnits(b.balance || '0', b.contractInfo?.decimals ?? 18)
    }));

  return {
    chainId: network.chainId,
    chain: network.name,
    balances: [...native, ...erc20]
  };
}

// --- balances ---
export const balancesCommand: CommandModule = {
  command: 'balances',
  describe: 'Check token balances',
  builder: (yargs) =>
    withWalletAndChain(yargs).option('chains', {
      type: 'string',
      describe:
        'Comma-separated chain names or IDs (e.g. polygon,base,arbitrum). When set, overrides --chain. Two or more chains return multi-chain JSON (TTY included).'
    }),
  handler: async (argv) => {
    const walletName = argv.wallet as string;
    const chainListRaw = parseCommaChainList(argv.chains as string | undefined);
    if (chainListRaw.length > BALANCES_MAX_CHAINS) {
      console.error(
        JSON.stringify(
          {
            ok: false,
            error: `Too many chains in --chains (max ${BALANCES_MAX_CHAINS}).`
          },
          null,
          2
        )
      );
      process.exit(1);
    }
    const chainList = chainListRaw;

    const preferChainsArg = chainList.length > 0;
    const singleChainSpec = preferChainsArg ? chainList[0] : (argv.chain as string) || undefined;
    const multiChainMode = preferChainsArg && chainList.length > 1;

    if (multiChainMode || (preferChainsArg && !isTTY())) {
      try {
        const pointer = await loadOmsWalletPointer(walletName);
        if (!pointer) {
          throw new Error(`Wallet not found: ${walletName}. Run: agent wallet login`);
        }
        const walletAddress = pointer.walletAddress;

        if (multiChainMode) {
          const chainsOut = await Promise.all(
            chainList.map((spec) => fetchBalancesRowsForChain(walletName, walletAddress, spec))
          );
          console.log(
            JSON.stringify(
              {
                ok: true,
                walletName,
                walletAddress,
                multiChain: true,
                chains: chainsOut
              },
              bigintReplacer,
              2
            )
          );
        } else {
          const one = await fetchBalancesRowsForChain(walletName, walletAddress, singleChainSpec!);
          console.log(
            JSON.stringify(
              {
                ok: true,
                walletName,
                walletAddress,
                chainId: one.chainId,
                chain: one.chain,
                balances: one.balances
              },
              bigintReplacer,
              2
            )
          );
        }
      } catch (error) {
        console.error(JSON.stringify(failureJson(error), bigintReplacer, 2));
        process.exit(1);
      }
      return;
    }

    if (!isTTY()) {
      // Non-TTY: original JSON output (single default / --chain)
      try {
        const pointer = await loadOmsWalletPointer(walletName);
        if (!pointer) {
          throw new Error(`Wallet not found: ${walletName}. Run: agent wallet login`);
        }

        const chainSpec = (argv.chain as string) || 'polygon';
        const one = await fetchBalancesRowsForChain(walletName, pointer.walletAddress, chainSpec);

        console.log(
          JSON.stringify(
            {
              ok: true,
              walletName,
              walletAddress: pointer.walletAddress,
              chainId: one.chainId,
              chain: one.chain,
              balances: one.balances
            },
            bigintReplacer,
            2
          )
        );
      } catch (error) {
        console.error(JSON.stringify(failureJson(error), bigintReplacer, 2));
        process.exit(1);
      }
    } else {
      // TTY: Ink UI
      let failed = false;
      try {
        await inkRender(
          React.createElement(BalancesUI, {
            walletName,
            chainOverride: preferChainsArg ? singleChainSpec : (argv.chain as string | undefined)
          })
        );
      } catch {
        failed = true;
      }
      if (failed) process.exit(1);
    }
  }
};

// The wallet funding page (Trails on-ramp + swap). Single source of truth so
// the `fund` command and the post-login step show the same thing: the
// agentconnect dashboard (same host as the login page), which reads
// ?wallet&chain&view. POLYGON_AGENT_FUNDING_UI overrides per environment.
function fundingUiBase(): string {
  const v = process.env.POLYGON_AGENT_FUNDING_UI;
  return v ? v.replace(/\/+$/, '') : loginUiBaseUrl();
}

/**
 * Post-login funding step, balance-aware. Checks the wallet's USD balance via the
 * OMS indexer and routes: funded (>0) -> dashboard, empty -> funding. On a
 * human's machine (local, incl. under Claude Code / a harness) it opens the page;
 * headless or --remote just returns the URL + balance on the CLI. Skipped by
 * --no-fund. Falls back to wallet.polygon.technology if no hosted page is configured.
 */
export async function showFunding(
  walletName: string,
  walletAddress: string,
  chainId = 137,
  opts?: { openBrowser?: boolean; remote?: boolean }
): Promise<void> {
  const funded = await isWalletFunded(walletName, walletAddress, chainId);
  const view = funded ? 'dashboard' : 'fund';

  const base = fundingUiBase();
  const url = `${base}/?wallet=${walletAddress}&chain=${chainId}&view=${view}`;

  // Human path (local, incl. under Claude Code / a harness where stdout is piped
  // so there is no TTY): open the page. Headless or --remote (browser elsewhere):
  // skip it and surface the URL + balance on the CLI. open() no-ops/throws on a
  // GUI-less host, so attempting it is safe.
  if (opts?.openBrowser && !opts?.remote) {
    try {
      const { default: open } = await import('open');
      await open(url);
    } catch {
      // open() can fail on a headless host — the URL/panel below is the fallback.
    }
  }

  if (isTTY()) {
    await inkRender(
      React.createElement(FundUI, {
        walletName,
        walletAddress,
        chainId,
        fundingUrl: url,
        funded
      })
    );
  } else {
    console.log(
      JSON.stringify(
        {
          ok: true,
          walletName,
          walletAddress,
          chainId,
          funded,
          view,
          url,
          message: funded
            ? `Wallet ${walletAddress} is funded. Dashboard: ${url}`
            : `Fund wallet ${walletAddress} (no balance yet). Add funds: ${url}`
        },
        null,
        2
      )
    );
  }
}

// --- fund ---
export const fundCommand: CommandModule = {
  command: 'fund',
  describe: 'Get funding URL for wallet',
  builder: (yargs) => withWalletAndChain(yargs),
  handler: async (argv) => {
    const walletName = argv.wallet as string;

    try {
      const session = await loadOmsWalletPointer(walletName);
      if (!session) {
        throw new Error(`Wallet not found: ${walletName}. Run: agent wallet login`);
      }

      await showFunding(walletName, session.walletAddress, 137, { openBrowser: true });
    } catch (error) {
      console.error(JSON.stringify(failureJson(error), bigintReplacer, 2));
      process.exit(1);
    }
  }
};

// --- send ---
export const sendCommand: CommandModule = {
  command: 'send',
  describe: 'Send native token (auto-detect with --symbol for ERC20)',
  builder: (yargs) =>
    withWriteFlags(
      withWalletAndChain(yargs)
        .option('to', {
          type: 'string',
          demandOption: true,
          describe: 'Recipient address',
          coerce: fileCoerce
        })
        .option('amount', {
          type: 'string',
          demandOption: true,
          describe: 'Amount to send',
          coerce: fileCoerce
        })
        .option('symbol', {
          type: 'string',
          describe: 'Token symbol (for ERC20)',
          coerce: fileCoerce
        })
        .option('token', {
          type: 'string',
          describe: 'Token contract address',
          coerce: fileCoerce
        })
        .option('decimals', {
          type: 'number',
          describe: 'Token decimals (when using --token)'
        })
    ),
  handler: async (argv) => {
    const symbol = argv.symbol as string | undefined;
    const token = argv.token as string | undefined;

    if (symbol || token) {
      await handleSendToken(argv);
    } else {
      await handleSendNative(argv);
    }
  }
};

// --- send-native ---
export const sendNativeCommand: CommandModule = {
  command: 'send-native',
  describe: 'Send native token (explicit)',
  builder: (yargs) =>
    withWriteFlags(
      withWalletAndChain(yargs)
        .option('to', {
          type: 'string',
          demandOption: true,
          describe: 'Recipient address',
          coerce: fileCoerce
        })
        .option('amount', {
          type: 'string',
          demandOption: true,
          describe: 'Amount to send',
          coerce: fileCoerce
        })
        .option('direct', {
          type: 'boolean',
          default: false,
          describe: 'Bypass ValueForwarder'
        })
    ),
  handler: (argv) => handleSendNative(argv)
};

async function handleSendNative(argv: {
  wallet?: string;
  to?: string;
  amount?: string;
  chain?: string;
  broadcast?: boolean;
  direct?: boolean;
  [key: string]: unknown;
}): Promise<void> {
  const walletName = (argv.wallet as string) || 'main';
  const to = argv.to as string;
  const amount = argv.amount as string;
  const broadcast = resolveBroadcast(argv);

  // Build transaction and execute
  async function exec(): Promise<{
    txHash?: string;
    explorerUrl?: string;
    walletAddress?: string;
  }> {
    const session = await loadOmsWalletPointer(walletName);
    if (!session) throw new Error(`Wallet not found: ${walletName}. Run: agent wallet login`);

    const network = resolveNetwork((argv.chain as string) || 'polygon');
    const decimals = network.nativeToken?.decimals ?? 18;
    const value = parseUnits(amount, decimals);

    const useDirectNative =
      (argv.direct as boolean) ||
      ['1', 'true', 'yes'].includes(String(process.env.SEQ_ECO_NATIVE_DIRECT || '').toLowerCase());

    const VALUE_FORWARDER = '0xABAAd93EeE2a569cF0632f39B10A9f5D734777ca';
    const selector = '0x98f850f1';
    const pad = (hex: string, n = 64) => String(hex).replace(/^0x/, '').padStart(n, '0');
    const data = selector + pad(to) + pad('0x' + value.toString(16));

    const transactions = useDirectNative
      ? [{ to, value, data: '0x' }]
      : [{ to: VALUE_FORWARDER, value, data }];

    const result = await runDappClientTx({
      walletName,
      chainId: network.chainId,
      transactions,
      broadcast,
      preferNativeFee: true
    });

    if (!broadcast) return {};
    const explorerUrl = getExplorerUrl(network, result.txHash ?? '');
    return { txHash: result.txHash, explorerUrl, walletAddress: result.walletAddress };
  }

  if (!isTTY()) {
    // Non-TTY: original JSON output
    try {
      const session = await loadOmsWalletPointer(walletName);
      if (!session) throw new Error(`Wallet not found: ${walletName}. Run: agent wallet login`);

      const network = resolveNetwork((argv.chain as string) || 'polygon');
      const decimals = network.nativeToken?.decimals ?? 18;
      const value = parseUnits(amount, decimals);

      const useDirectNative =
        (argv.direct as boolean) ||
        ['1', 'true', 'yes'].includes(
          String(process.env.SEQ_ECO_NATIVE_DIRECT || '').toLowerCase()
        );

      const VALUE_FORWARDER = '0xABAAd93EeE2a569cF0632f39B10A9f5D734777ca';
      const selector = '0x98f850f1';
      const pad = (hex: string, n = 64) => String(hex).replace(/^0x/, '').padStart(n, '0');
      const data = selector + pad(to) + pad('0x' + value.toString(16));

      const transactions = useDirectNative
        ? [{ to, value, data: '0x' }]
        : [{ to: VALUE_FORWARDER, value, data }];

      const result = await runDappClientTx({
        walletName,
        chainId: network.chainId,
        transactions,
        broadcast,
        preferNativeFee: true
      });

      if (!broadcast) return;

      const explorerUrl = getExplorerUrl(network, result.txHash ?? '');
      console.log(
        JSON.stringify(
          {
            ok: true,
            walletName,
            walletAddress: result.walletAddress,
            chain: network.name,
            chainId: network.chainId,
            to,
            amount,
            txHash: result.txHash,
            explorerUrl
          },
          null,
          2
        )
      );
    } catch (error) {
      console.error(JSON.stringify(failureJson(error), bigintReplacer, 2));
      process.exit(1);
    }
  } else {
    // TTY: Ink UI
    let failed = false;
    try {
      const network = resolveNetwork((argv.chain as string) || 'polygon');
      const nativeSymbol = network.nativeToken?.symbol || 'POL';

      await inkRender(
        React.createElement(SendUI, {
          walletName,
          to,
          amount,
          symbol: nativeSymbol,
          broadcast,
          onExec: exec
        })
      );
    } catch {
      failed = true;
    }
    if (failed) process.exit(1);
  }
}

// --- send-token ---
export const sendTokenCommand: CommandModule = {
  command: 'send-token',
  describe: 'Send ERC20 by symbol',
  builder: (yargs) =>
    withWriteFlags(
      withWalletAndChain(yargs)
        .option('symbol', {
          type: 'string',
          describe: 'Token symbol',
          coerce: fileCoerce
        })
        .option('token', {
          type: 'string',
          describe: 'Token contract address',
          coerce: fileCoerce
        })
        .option('decimals', {
          type: 'number',
          describe: 'Token decimals (when using --token)'
        })
        .option('to', {
          type: 'string',
          demandOption: true,
          describe: 'Recipient address',
          coerce: fileCoerce
        })
        .option('amount', {
          type: 'string',
          demandOption: true,
          describe: 'Amount to send',
          coerce: fileCoerce
        })
    ),
  handler: (argv) => handleSendToken(argv)
};

async function handleSendToken(argv: {
  wallet?: string;
  symbol?: string;
  token?: string;
  decimals?: number;
  to?: string;
  amount?: string;
  chain?: string;
  broadcast?: boolean;
  [key: string]: unknown;
}): Promise<void> {
  const walletName = (argv.wallet as string) || 'main';
  const symbolArg = argv.symbol as string | undefined;
  const tokenAddress = argv.token as string | undefined;
  const decimalsArg = argv.decimals as number | undefined;
  const to = argv.to as string;
  const amount = argv.amount as string;
  const broadcast = resolveBroadcast(argv);

  // Resolve token info
  async function resolveToken(): Promise<{
    token: string;
    decimals: number;
    resolvedSymbol: string;
    network: ReturnType<typeof resolveNetwork>;
  }> {
    const session = await loadOmsWalletPointer(walletName);
    if (!session) throw new Error(`Wallet not found: ${walletName}. Run: agent wallet login`);

    const network = resolveNetwork((argv.chain as string) || 'polygon');
    let token = tokenAddress;
    let decimals = decimalsArg ?? null;
    let resolvedSymbol = symbolArg || 'TOKEN';

    if (symbolArg) {
      const resolved = await resolveErc20BySymbol({ chainId: network.chainId, symbol: symbolArg });
      if (!resolved) throw new Error(`Unknown token symbol: ${symbolArg} on ${network.name}`);
      token = resolved.address;
      decimals = Number(resolved.decimals);
      resolvedSymbol = symbolArg;
    }

    if (!token || decimals === null)
      throw new Error('Provide either --symbol OR (--token + --decimals)');
    return { token, decimals, resolvedSymbol, network };
  }

  async function exec(): Promise<{
    txHash?: string;
    explorerUrl?: string;
    walletAddress?: string;
  }> {
    const { token, decimals, network } = await resolveToken();
    const value = parseUnits(amount, decimals);
    const selector = '0xa9059cbb';
    const pad = (hex: string, n = 64) => String(hex).replace(/^0x/, '').padStart(n, '0');
    const data = selector + pad(to) + pad('0x' + value.toString(16));

    const result = await runDappClientTx({
      walletName,
      chainId: network.chainId,
      transactions: [{ to: token, value: 0n, data }],
      broadcast,
      preferNativeFee: false
    });

    if (!broadcast) return {};
    const explorerUrl = getExplorerUrl(network, result.txHash ?? '');
    return { txHash: result.txHash, explorerUrl, walletAddress: result.walletAddress };
  }

  if (!isTTY()) {
    // Non-TTY: original JSON output
    try {
      const { token, decimals, resolvedSymbol, network } = await resolveToken();
      const value = parseUnits(amount, decimals);
      const selector = '0xa9059cbb';
      const pad = (hex: string, n = 64) => String(hex).replace(/^0x/, '').padStart(n, '0');
      const data = selector + pad(to) + pad('0x' + value.toString(16));

      const result = await runDappClientTx({
        walletName,
        chainId: network.chainId,
        transactions: [{ to: token, value: 0n, data }],
        broadcast,
        preferNativeFee: false
      });

      if (!broadcast) return;

      const explorerUrl = getExplorerUrl(network, result.txHash ?? '');
      console.log(
        JSON.stringify(
          {
            ok: true,
            walletName,
            walletAddress: result.walletAddress,
            chain: network.name,
            chainId: network.chainId,
            symbol: resolvedSymbol,
            tokenAddress: token,
            decimals,
            to,
            amount,
            txHash: result.txHash,
            explorerUrl
          },
          null,
          2
        )
      );
    } catch (error) {
      console.error(JSON.stringify(failureJson(error), bigintReplacer, 2));
      process.exit(1);
    }
  } else {
    // TTY: Ink UI
    let failed = false;
    try {
      const { resolvedSymbol } = await resolveToken();
      await inkRender(
        React.createElement(SendUI, {
          walletName,
          to,
          amount,
          symbol: resolvedSymbol,
          broadcast,
          onExec: exec
        })
      );
    } catch {
      failed = true;
    }
    if (failed) process.exit(1);
  }
}

// --- call ---
// Generic raw-calldata submitter. Thin wrapper over runDappClientTx:
// takes a target contract, pre-encoded calldata, and optional native value,
// and submits as a single transaction through the active wallet session.
// All ABI encoding is the caller's responsibility (use viem encodeFunctionData,
// ethers Interface, `cast calldata`, etc.) — keeping this command domain-free.
async function handleCall(argv: {
  wallet?: string;
  to: string;
  data: string;
  value?: string;
  chain?: string;
  broadcast?: boolean;
  'prefer-native-fee'?: boolean;
}): Promise<void> {
  const walletName = argv.wallet || 'main';
  const broadcast = resolveBroadcast(argv);
  const preferNativeFee = argv['prefer-native-fee'] || false;

  if (!/^0x[0-9a-fA-F]{40}$/.test(argv.to)) {
    throw new Error('--to must be a 0x-prefixed 20-byte address');
  }
  if (!/^0x[0-9a-fA-F]*$/.test(argv.data)) {
    throw new Error('--data must be 0x-prefixed hex (use viem/ethers/cast to encode)');
  }

  const session = await loadOmsWalletPointer(walletName);
  if (!session) throw new Error(`Wallet not found: ${walletName}. Run: agent wallet login`);

  const network = resolveNetwork(argv.chain || 'polygon');
  const decimals = network.nativeToken?.decimals ?? 18;
  const value = argv.value ? parseUnits(argv.value, decimals) : 0n;

  // Default: pay gas in an ERC20 fee token (USDC etc.) — matches the rest of
  // the CLI's gasless UX. Pass --prefer-native-fee to flip to native (POL/ETH)
  // first; useful when the wallet has only native balance.
  const result = await runDappClientTx({
    walletName,
    chainId: network.chainId,
    transactions: [{ to: argv.to, value, data: argv.data }],
    broadcast,
    preferNativeFee
  });

  if (!broadcast) return; // runDappClientTx already printed dry-run JSON

  const explorerUrl = getExplorerUrl(network, result.txHash ?? '');
  console.log(
    JSON.stringify(
      {
        ok: true,
        txHash: result.txHash,
        explorerUrl,
        walletAddress: result.walletAddress
      },
      null,
      2
    )
  );
}

export const callCommand: CommandModule = {
  command: 'call',
  describe: 'Submit a raw contract call (pre-encoded calldata) via the active wallet session',
  builder: (yargs) =>
    withWriteFlags(
      withWalletAndChain(yargs)
        .option('to', {
          type: 'string',
          demandOption: true,
          describe: 'Contract address to call',
          coerce: fileCoerce
        })
        .option('data', {
          type: 'string',
          demandOption: true,
          describe: 'Pre-encoded calldata (0x-prefixed hex). Use @path to read from a file.',
          coerce: fileCoerce
        })
        .option('value', {
          type: 'string',
          describe: 'Native token value to attach (human units, e.g. 0.01). Default 0.',
          coerce: fileCoerce
        })
        .option('prefer-native-fee', {
          type: 'boolean',
          default: false,
          describe:
            'Pay gas in the chain native token (POL/ETH) instead of an ERC20 fee token (USDC).'
        })
    ),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleCall(argv as any)
};

// --- swap ---
interface SwapArgs {
  action?: string;
  wallet?: string;
  chain?: string;
  from?: string;
  to?: string;
  amount?: string;
  'amount-usd'?: number;
  slippage?: number;
  'to-chain'?: string;
  intent?: string;
  timeout?: number;
  broadcast?: boolean;
  dryRun?: boolean;
}

function requireTrade(intentId: string | undefined): TradeRecord {
  if (!intentId) {
    throw new CliError({ code: 'invalid_input', message: 'Give the trade with --intent <id>.' });
  }
  const trade = loadTrade(intentId);
  if (!trade) {
    throw new CliError({
      code: 'invalid_input',
      message: `No saved trade ${intentId} on this install.`
    });
  }
  return trade;
}

// Prints where the trade ended up; refunded and failed trades exit 1.
function reportTrade(trade: TradeRecord): void {
  const network = resolveNetwork(trade.origin.chainId);
  const result = {
    ...describeTrade(trade),
    ...(trade.depositTxHash
      ? { depositExplorerUrl: getExplorerUrl(network, trade.depositTxHash) }
      : {})
  };
  if (trade.state === 'refunded' || trade.state === 'failed') {
    console.error(
      JSON.stringify(
        {
          ok: false,
          code: 'trade_failed',
          error:
            trade.state === 'refunded'
              ? 'The trade failed and Trails refunded the deposit to the wallet.'
              : `The trade failed: ${trade.error ?? 'Trails reported a failure'}.`,
          ...result
        },
        bigintReplacer,
        2
      )
    );
    process.exit(1);
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        walletName: trade.walletName,
        walletAddress: trade.walletAddress,
        ...result,
        ...(trade.state === 'executing'
          ? {
              hint: 'Trails is still working on it.',
              command: `polygon-agent swap status --intent ${trade.intentId}`
            }
          : {})
      },
      bigintReplacer,
      2
    )
  );
}

export const swapCommand: CommandModule<object, SwapArgs> = {
  command: 'swap [action]',
  describe: 'Swap or bridge tokens via Trails (swap status --intent <id> to follow one)',
  builder: (yargs) =>
    withWriteFlags(
      withWalletAndChain(yargs)
        .positional('action', {
          type: 'string',
          choices: ['status'],
          describe: 'status: resume or report a trade (--intent)'
        })
        .option('from', {
          type: 'string',
          describe: 'Token to sell (default: a covered stablecoin with enough balance)',
          coerce: fileCoerce
        })
        .option('to', { type: 'string', describe: 'Token to buy', coerce: fileCoerce })
        .option('amount', {
          type: 'string',
          describe: 'Amount to sell: a number, <n>%, or all',
          coerce: fileCoerce
        })
        .option('amount-usd', { type: 'number', describe: 'Amount to sell, in USD' })
        .option('slippage', { type: 'number', describe: 'Slippage tolerance (default 0.005)' })
        .option('to-chain', { type: 'string', describe: 'Destination chain (bridges)' })
        .option('intent', {
          type: 'string',
          describe: 'A quoted trade to execute (with --broadcast), or to follow (status)'
        })
        .option('timeout', {
          type: 'number',
          default: DEFAULT_TRADE_TIMEOUT_MS / 1000,
          describe: 'Seconds to wait for completion'
        })
    ),
  handler: async (argv) => {
    try {
      const timeoutSeconds = argv.timeout ?? DEFAULT_TRADE_TIMEOUT_MS / 1000;
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
        throw new CliError({
          code: 'invalid_input',
          message: '--timeout must be seconds (0 or more).'
        });
      }
      const timeoutMs = timeoutSeconds * 1000;
      if (argv.action === 'status') {
        // An unfinished trade picks up where it stopped; a quote is never sent.
        reportTrade(
          await executeSwap({ trade: requireTrade(argv.intent), timeoutMs, send: false })
        );
        return;
      }

      const broadcast = resolveBroadcast(argv);
      let trade: TradeRecord;
      let warnings: string[] = [];
      if (argv.intent) {
        trade = requireTrade(argv.intent);
      } else {
        // A sell without --to goes to USDC on the same chain.
        const to = argv.to ?? (argv.from ? 'USDC' : undefined);
        if (!to) {
          throw new CliError({
            code: 'invalid_input',
            message: 'Give the token to buy with --to.'
          });
        }
        ({ trade, warnings } = await quoteSwap({
          walletName: argv.wallet || 'main',
          from: argv.from,
          to,
          amount: argv.amount,
          amountUsd: argv['amount-usd'],
          chain: argv.chain,
          toChain: argv['to-chain'],
          slippage: argv.slippage,
          now: new Date()
        }));
      }

      if (!broadcast) {
        // In session mode, the deposit is checked against the allowance now.
        const allowance =
          trade.mode === 'session'
            ? await checkSessionSpend({
                walletName: trade.walletName,
                walletAddress: trade.walletAddress,
                chainId: trade.origin.chainId,
                token: getAddress(trade.origin.token),
                amount: BigInt(trade.origin.amount)
              })
            : undefined;
        console.log(
          JSON.stringify(
            {
              ok: true,
              dryRun: true,
              walletName: trade.walletName,
              walletAddress: trade.walletAddress,
              ...describeTrade(trade),
              ...(allowance
                ? {
                    allowance: {
                      usd: allowance.usd,
                      spentUsd: allowance.spentUsd,
                      allowanceUsd: allowance.allowanceUsd,
                      remainingOnChain:
                        allowance.remaining === null
                          ? null
                          : formatUnits(allowance.remaining, allowance.decimals)
                    }
                  }
                : {}),
              ...(warnings.length ? { warnings } : {}),
              hint: 'Nothing was sent. Show the user the quote; to execute it before it expires:',
              command: `polygon-agent swap --intent ${trade.intentId} --broadcast`
            },
            bigintReplacer,
            2
          )
        );
        return;
      }

      reportTrade(await executeSwap({ trade, timeoutMs }));
    } catch (error) {
      console.error(JSON.stringify(failureJson(error), bigintReplacer, 2));
      process.exit(1);
    }
  }
};

// --- deposit ---
export const depositCommand: CommandModule = {
  command: 'deposit',
  describe: 'Deposit ERC20 to earn yield (Trails earn pools)',
  builder: (yargs) =>
    withWriteFlags(
      withWalletAndChain(yargs)
        .option('asset', {
          type: 'string',
          default: 'USDC',
          describe: 'Asset symbol'
        })
        .option('amount', {
          type: 'string',
          demandOption: true,
          describe: 'Amount to deposit',
          coerce: fileCoerce
        })
        .option('protocol', {
          type: 'string',
          describe: 'Filter by protocol (aave, morpho)'
        })
    ),
  handler: async (argv) => {
    const walletName = (argv.wallet as string) || 'main';
    const assetSymbol = ((argv.asset as string) || 'USDC').toUpperCase();
    let amountArg = argv.amount as string;
    const protocolFilter = argv.protocol as string | undefined;
    const broadcast = resolveBroadcast(argv as { broadcast?: boolean; dryRun?: boolean });

    try {
      const session = await loadOmsWalletPointer(walletName);
      if (!session) throw new Error(`Wallet not found: ${walletName}. Run: agent wallet login`);

      const network = resolveNetwork((argv.chain as string) || 'polygon');
      const { chainId } = network;
      const walletAddress = session.walletAddress;

      const asset = await getTokenConfig({
        chainId,
        symbol: assetSymbol,
        nativeSymbol: network.nativeToken?.symbol || 'POL'
      });
      if (asset.address === '0x0000000000000000000000000000000000000000') {
        throw new Error('Native token deposits are not supported; use an ERC20 like USDC');
      }

      const { TrailsApi } = await import('@0xtrails/api');
      const trailsApiKey =
        process.env.TRAILS_API_KEY ||
        process.env.SEQUENCE_PROJECT_ACCESS_KEY ||
        (await loadBuilderConfig())?.accessKey ||
        '';
      const trails = new TrailsApi(trailsApiKey, {
        hostname: process.env.TRAILS_API_HOSTNAME
      });

      const earnRes = await trails.getEarnPools({ chainIds: [chainId] });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let pools = ((earnRes as any)?.pools || []).filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (p: any) =>
          p.isActive && p.chainId === chainId && p.token?.symbol?.toUpperCase() === assetSymbol
      );

      if (protocolFilter) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pools = pools.filter((p: any) =>
          p.protocol?.toLowerCase().includes(protocolFilter.toLowerCase())
        );
      }

      if (pools.length === 0) {
        throw new Error(
          `No active ${assetSymbol} earn pools found on ${network.name}` +
            (protocolFilter ? ` (protocol: ${protocolFilter})` : '') +
            `. Confirm wallet state: agent balances. ` +
            `Alternative: agent swap --from ${assetSymbol} --to <yield-token>.`
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pools.sort((a: any, b: any) => b.tvl - a.tvl);
      const pool = pools[0];
      const proto = (pool.protocol || '').toLowerCase();

      const {
        encodeFunctionData,
        parseUnits: viemParseUnits,
        formatUnits: viemFormatUnits,
        createPublicClient,
        http
      } = await import('viem');
      // Pre-flight: verify balance and auto-reserve gas buffer
      try {
        const viemChain = await viemChainForDeposit(chainId);
        const publicClient = createPublicClient({ chain: viemChain, transport: http() });
        const [usdcBal, nativeBal] = await Promise.all([
          publicClient.readContract({
            address: asset.address as `0x${string}`,
            abi: ERC20_BALANCE_OF_ABI,
            functionName: 'balanceOf',
            args: [walletAddress as `0x${string}`]
          }),
          publicClient.getBalance({ address: walletAddress as `0x${string}` })
        ]);
        const requestedUnits = viemParseUnits(amountArg, asset.decimals);
        const USDC_GAS_RESERVE = viemParseUnits('0.1', asset.decimals);
        const POL_GAS_RESERVE = viemParseUnits('0.1', 18);
        if (usdcBal < requestedUnits) {
          const available = viemFormatUnits(usdcBal, asset.decimals);
          throw new Error(
            `Insufficient ${assetSymbol}: wallet has ${available} ${assetSymbol}, deposit requires ${amountArg}. ` +
              `Run: agent balances`
          );
        }
        if (nativeBal < POL_GAS_RESERVE && requestedUnits + USDC_GAS_RESERVE > usdcBal) {
          // Not enough POL to cover gas — USDC paymaster will be used; reserve 0.1 USDC
          const adjusted = usdcBal - USDC_GAS_RESERVE;
          if (adjusted <= 0n) {
            throw new Error(
              `Insufficient ${assetSymbol} for deposit plus 0.1 gas reserve. ` +
                `Fund with at least 0.1 POL for native gas or ensure USDC balance exceeds deposit by 0.1: agent fund`
            );
          }
          amountArg = viemFormatUnits(adjusted, asset.decimals);
          process.stderr.write(
            `Note: reduced deposit to ${amountArg} ${assetSymbol} (0.1 reserved for USDC gas paymaster — fund with POL to avoid this)\n`
          );
        }
      } catch (e) {
        if ((e as Error).message?.match(/^Insufficient/)) throw e;
        // RPC unreachable — warn and continue
        process.stderr.write(
          `Warning: balance pre-flight check skipped (${(e as Error).message})\n`
        );
      }

      const amountUnits = viemParseUnits(amountArg, asset.decimals);

      const ERC20_APPROVE_ABI = [
        {
          name: 'approve',
          type: 'function',
          inputs: [
            { name: 'spender', type: 'address' },
            { name: 'amount', type: 'uint256' }
          ],
          outputs: [{ name: '', type: 'bool' }]
        }
      ] as const;

      let transactions;
      let protocolLabel: string;

      if (proto.includes('aave')) {
        transactions = [
          {
            to: asset.address,
            value: 0n,
            data: encodeFunctionData({
              abi: ERC20_APPROVE_ABI,
              functionName: 'approve',
              args: [pool.depositAddress, amountUnits]
            })
          },
          {
            to: pool.depositAddress,
            value: 0n,
            data: encodeFunctionData({
              abi: [
                {
                  name: 'supply',
                  type: 'function',
                  inputs: [
                    { name: 'asset', type: 'address' },
                    { name: 'amount', type: 'uint256' },
                    { name: 'onBehalfOf', type: 'address' },
                    { name: 'referralCode', type: 'uint16' }
                  ],
                  outputs: []
                }
              ] as const,
              functionName: 'supply',
              args: [asset.address as `0x${string}`, amountUnits, walletAddress as `0x${string}`, 0]
            })
          }
        ];
        protocolLabel = pool.name || 'Aave v3';
      } else if (proto.includes('morpho')) {
        transactions = [
          {
            to: asset.address,
            value: 0n,
            data: encodeFunctionData({
              abi: ERC20_APPROVE_ABI,
              functionName: 'approve',
              args: [pool.depositAddress, amountUnits]
            })
          },
          {
            to: pool.depositAddress,
            value: 0n,
            data: encodeFunctionData({
              abi: [
                {
                  name: 'deposit',
                  type: 'function',
                  inputs: [
                    { name: 'assets', type: 'uint256' },
                    { name: 'receiver', type: 'address' }
                  ],
                  outputs: [{ name: 'shares', type: 'uint256' }]
                }
              ] as const,
              functionName: 'deposit',
              args: [amountUnits, walletAddress as `0x${string}`]
            })
          }
        ];
        protocolLabel = pool.name || 'Morpho';
      } else {
        throw new Error(
          `Protocol "${pool.protocol}" from Trails is not yet supported for direct deposit encoding. ` +
            `Supported: aave, morpho. Open an issue or use 'agent swap' to obtain the yield-bearing token.`
        );
      }

      if (!broadcast) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              dryRun: true,
              walletName,
              walletAddress,
              protocol: pool.protocol,
              poolName: protocolLabel,
              poolApy: `${pool.apy.toFixed(2)}%`,
              poolTvl: pool.tvl,
              depositAddress: pool.depositAddress,
              asset: assetSymbol,
              amount: amountArg,
              chainId,
              chain: network.name,
              transactions,
              note: `Submits as two transactions (approve + supply) — non-atomic. Re-run with --broadcast to submit. Ensure the wallet holds ${assetSymbol} plus a little POL or USDC for gas.`
            },
            bigintReplacer,
            2
          )
        );
        return;
      }

      // NON-ATOMIC: deposit submits approve + supply sequentially via runOmsTx.
      const result = await runDappClientTx({
        walletName,
        chainId,
        transactions,
        broadcast,
        preferNativeFee: false
      });

      console.log(
        JSON.stringify(
          {
            ok: true,
            walletName,
            walletAddress,
            protocol: pool.protocol,
            poolName: protocolLabel,
            poolApy: `${pool.apy.toFixed(2)}%`,
            asset: assetSymbol,
            amount: amountArg,
            chainId,
            chain: network.name,
            txHash: result.txHash,
            explorerUrl: getExplorerUrl(network, result.txHash ?? ''),
            note: `${assetSymbol} is now earning yield in ${protocolLabel}. You will receive an interest-bearing token in your wallet.`
          },
          bigintReplacer,
          2
        )
      );
    } catch (error) {
      console.error(JSON.stringify(failureJson(error), bigintReplacer, 2));
      process.exit(1);
    }
  }
};

const AAVE_ATOKEN_META_ABI = [
  {
    name: 'POOL',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }]
  },
  {
    name: 'UNDERLYING_ASSET_ADDRESS',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }]
  }
] as const;

const ERC20_DECIMALS_ABI = [
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }]
  }
] as const;

const ERC20_BALANCE_OF_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }]
  }
] as const;

const ERC4626_ASSET_ABI = [
  {
    name: 'asset',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }]
  }
] as const;

const ERC4626_CONVERT_TO_SHARES_ABI = [
  {
    name: 'convertToShares',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'assets', type: 'uint256' }],
    outputs: [{ type: 'uint256' }]
  }
] as const;

const AAVE_POOL_WITHDRAW_ABI = [
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' }
    ],
    outputs: [{ type: 'uint256' }]
  }
] as const;

const ERC4626_REDEEM_ABI = [
  {
    name: 'redeem',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'shares', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'owner', type: 'address' }
    ],
    outputs: [{ type: 'uint256' }]
  }
] as const;

async function viemChainMap() {
  const { mainnet, polygon, arbitrum, optimism, base, avalanche, bsc, gnosis, polygonAmoy } =
    await import('viem/chains');
  return {
    1: mainnet,
    137: polygon,
    42161: arbitrum,
    10: optimism,
    8453: base,
    43114: avalanche,
    56: bsc,
    100: gnosis,
    80002: polygonAmoy
  } as const satisfies Record<number, unknown>;
}

async function viemChainForDeposit(chainId: number) {
  const map = await viemChainMap();
  const c = map[chainId as keyof typeof map];
  if (!c)
    throw new Error(
      `deposit: chainId ${chainId} has no bundled viem chain config for pre-flight check.`
    );
  return c;
}

async function viemChainForWithdraw(chainId: number) {
  const map = await viemChainMap();
  const c = map[chainId as keyof typeof map];
  if (!c) {
    throw new Error(
      `withdraw: chainId ${chainId} has no bundled viem chain config. Extend viemChainForWithdraw or use a supported chain.`
    );
  }
  return c;
}

// --- withdraw ---
export const withdrawCommand: CommandModule = {
  command: 'withdraw',
  describe: 'Withdraw from an Aave v3 aToken position or ERC-4626 vault (dry-run by default)',
  builder: (yargs) =>
    withWriteFlags(
      withWalletAndChain(yargs)
        .option('position', {
          type: 'string',
          describe:
            'Position token: Aave aToken address, or ERC-4626 vault (share token) address. (Optional if --asset and --protocol are used)',
          coerce: fileCoerce
        })
        .option('asset', {
          type: 'string',
          describe:
            'Asset symbol (e.g. USDC). Used with --protocol to auto-discover the position address.'
        })
        .option('protocol', {
          type: 'string',
          describe:
            'Filter by protocol (e.g. aave, morpho). Used with --asset to auto-discover the position address.'
        })
        .option('amount', {
          type: 'string',
          demandOption: true,
          describe:
            'Underlying amount to withdraw (Aave), or max | partial underlying (ERC-4626). Use max for full exit.',
          coerce: fileCoerce
        })
    ),
  handler: async (argv) => {
    const walletName = (argv.wallet as string) || 'main';
    const amountArg = String(argv.amount || '')
      .trim()
      .toLowerCase();
    const broadcast = resolveBroadcast(argv as { broadcast?: boolean; dryRun?: boolean });
    const protocolFilter = (argv.protocol as string)?.toLowerCase();
    const assetSymbol = (argv.asset as string)?.toUpperCase();

    try {
      const session = await loadOmsWalletPointer(walletName);
      if (!session) throw new Error(`Wallet not found: ${walletName}. Run: agent wallet login`);

      const network = resolveNetwork((argv.chain as string) || 'polygon');
      const { chainId } = network;
      const walletAddress = session.walletAddress as `0x${string}`;

      const { createPublicClient, http, encodeFunctionData, maxUint256, parseUnits } =
        await import('viem');
      const viemChain = await viemChainForWithdraw(chainId);
      const publicClient = createPublicClient({
        chain: viemChain,
        transport: http(getReadRpcUrl(network))
      });

      let positionAddr = String(argv.position || '')
        .trim()
        .toLowerCase() as `0x${string}`;

      if (!positionAddr && assetSymbol && protocolFilter) {
        const asset = await getTokenConfig({
          chainId,
          symbol: assetSymbol,
          nativeSymbol: network.nativeToken?.symbol || 'POL'
        });

        const { TrailsApi } = await import('@0xtrails/api');
        const trailsApiKey =
          process.env.TRAILS_API_KEY ||
          process.env.SEQUENCE_PROJECT_ACCESS_KEY ||
          (await loadBuilderConfig())?.accessKey ||
          '';
        const trails = new TrailsApi(trailsApiKey, {
          hostname: process.env.TRAILS_API_HOSTNAME
        });

        const earnRes = await trails.getEarnPools({ chainIds: [chainId] });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let pools = ((earnRes as any)?.pools || []).filter(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (p: any) =>
            p.isActive &&
            p.chainId === chainId &&
            (p.token?.symbol?.toUpperCase() === assetSymbol ||
              p.token?.address?.toLowerCase() === asset.address.toLowerCase())
        );

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pools = pools.filter((p: any) => p.protocol?.toLowerCase().includes(protocolFilter));

        if (pools.length === 0) {
          throw new Error(
            `No active earn pools found for ${assetSymbol} on ${network.name} (protocol filter: ${protocolFilter}). Try passing --position explicitly.`
          );
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pools.sort((a: any, b: any) => b.tvl - a.tvl);
        const pool = pools[0];

        if (protocolFilter.includes('aave')) {
          const AAVE_POOL_RESERVE_DATA_ABI = [
            {
              inputs: [{ internalType: 'address', name: 'asset', type: 'address' }],
              name: 'getReserveData',
              outputs: [
                {
                  components: [
                    {
                      components: [{ internalType: 'uint256', name: 'data', type: 'uint256' }],
                      internalType: 'struct DataTypes.ReserveConfigurationMap',
                      name: 'configuration',
                      type: 'tuple'
                    },
                    { internalType: 'uint128', name: 'liquidityIndex', type: 'uint128' },
                    { internalType: 'uint128', name: 'currentLiquidityRate', type: 'uint128' },
                    { internalType: 'uint128', name: 'variableBorrowIndex', type: 'uint128' },
                    { internalType: 'uint128', name: 'currentVariableBorrowRate', type: 'uint128' },
                    { internalType: 'uint128', name: 'currentStableBorrowRate', type: 'uint128' },
                    { internalType: 'uint40', name: 'lastUpdateTimestamp', type: 'uint40' },
                    { internalType: 'uint16', name: 'id', type: 'uint16' },
                    { internalType: 'address', name: 'aTokenAddress', type: 'address' },
                    { internalType: 'address', name: 'stableDebtTokenAddress', type: 'address' },
                    { internalType: 'address', name: 'variableDebtTokenAddress', type: 'address' },
                    {
                      internalType: 'address',
                      name: 'interestRateStrategyAddress',
                      type: 'address'
                    },
                    { internalType: 'uint128', name: 'accruedToTreasury', type: 'uint128' },
                    { internalType: 'uint128', name: 'unbacked', type: 'uint128' },
                    { internalType: 'uint128', name: 'isolationModeTotalDebt', type: 'uint128' }
                  ],
                  internalType: 'struct DataTypes.ReserveData',
                  name: '',
                  type: 'tuple'
                }
              ],
              stateMutability: 'view',
              type: 'function'
            }
          ];

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const reserveData: any = await publicClient
            .readContract({
              address: pool.depositAddress as `0x${string}`,
              abi: AAVE_POOL_RESERVE_DATA_ABI,
              functionName: 'getReserveData',
              args: [asset.address as `0x${string}`]
            })
            .catch(() => null);

          if (!reserveData || !reserveData.aTokenAddress) {
            throw new Error(
              `Failed to resolve aToken address for ${assetSymbol} on Aave pool ${pool.depositAddress}. Try passing --position explicitly.`
            );
          }
          positionAddr = reserveData.aTokenAddress.toLowerCase() as `0x${string}`;
        } else {
          positionAddr = pool.depositAddress.toLowerCase() as `0x${string}`;
        }
      }

      if (!positionAddr.startsWith('0x') || positionAddr.length !== 42) {
        throw new Error(
          'Invalid or missing --position address (expected 0x + 40 hex chars). Provide --position or both --asset and --protocol.'
        );
      }

      const aaveMeta = await publicClient
        .readContract({
          address: positionAddr,
          abi: AAVE_ATOKEN_META_ABI,
          functionName: 'POOL'
        })
        .then(async (pool) => {
          const underlying = await publicClient.readContract({
            address: positionAddr,
            abi: AAVE_ATOKEN_META_ABI,
            functionName: 'UNDERLYING_ASSET_ADDRESS'
          });
          return { pool: pool as `0x${string}`, underlying: underlying as `0x${string}` };
        })
        .catch(() => null);

      let transactions: { to: `0x${string}`; value: bigint; data: `0x${string}` }[];
      let kind: 'aave' | 'erc4626';
      let summary: Record<string, unknown>;

      if (aaveMeta) {
        kind = 'aave';
        const underlyingDec = Number(
          await publicClient.readContract({
            address: aaveMeta.underlying,
            abi: ERC20_DECIMALS_ABI,
            functionName: 'decimals'
          })
        );
        const amountWei =
          amountArg === 'max' || amountArg === 'all'
            ? maxUint256
            : parseUnits(amountArg, underlyingDec);

        transactions = [
          {
            to: aaveMeta.pool,
            value: 0n,
            data: encodeFunctionData({
              abi: AAVE_POOL_WITHDRAW_ABI,
              functionName: 'withdraw',
              args: [aaveMeta.underlying, amountWei, walletAddress]
            })
          }
        ];
        summary = {
          protocol: 'aave',
          poolAddress: aaveMeta.pool,
          underlyingAsset: aaveMeta.underlying,
          aToken: positionAddr,
          amount: amountArg === 'max' || amountArg === 'all' ? 'max' : amountArg,
          underlyingDecimals: underlyingDec
        };
      } else {
        const underlying = await publicClient
          .readContract({
            address: positionAddr,
            abi: ERC4626_ASSET_ABI,
            functionName: 'asset'
          })
          .catch(() => null);

        if (!underlying) {
          throw new Error(
            `Could not treat position (${positionAddr}) as Aave aToken (POOL / UNDERLYING_ASSET_ADDRESS) or ERC-4626 vault (asset()). ` +
              'Pass the aToken or vault share contract you hold.'
          );
        }

        kind = 'erc4626';
        const underlyingAddr = underlying as `0x${string}`;
        const underlyingDec = Number(
          await publicClient.readContract({
            address: underlyingAddr,
            abi: ERC20_DECIMALS_ABI,
            functionName: 'decimals'
          })
        );

        const shareBal = await publicClient.readContract({
          address: positionAddr,
          abi: ERC20_BALANCE_OF_ABI,
          functionName: 'balanceOf',
          args: [walletAddress]
        });

        if (shareBal === 0n) {
          throw new Error('ERC-4626 share balance is zero for this wallet on this chain.');
        }

        let sharesOut: bigint;
        if (amountArg === 'max' || amountArg === 'all') {
          sharesOut = shareBal;
        } else {
          const assetsWei = parseUnits(amountArg, underlyingDec);
          sharesOut = await publicClient.readContract({
            address: positionAddr,
            abi: ERC4626_CONVERT_TO_SHARES_ABI,
            functionName: 'convertToShares',
            args: [assetsWei]
          });
          if (sharesOut > shareBal) {
            throw new Error(
              `Requested underlying withdraw exceeds vault shares (need ${sharesOut.toString()} shares, have ${shareBal.toString()}). Try --amount max.`
            );
          }
        }

        transactions = [
          {
            to: positionAddr,
            value: 0n,
            data: encodeFunctionData({
              abi: ERC4626_REDEEM_ABI,
              functionName: 'redeem',
              args: [sharesOut, walletAddress, walletAddress]
            })
          }
        ];
        summary = {
          protocol: 'erc4626',
          vault: positionAddr,
          underlyingAsset: underlyingAddr,
          sharesRedeemed: sharesOut.toString(),
          shareBalance: shareBal.toString(),
          underlyingDecimals: underlyingDec
        };
      }

      if (!broadcast) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              dryRun: true,
              walletName,
              walletAddress,
              chainId,
              chain: network.name,
              kind,
              ...summary,
              transactions,
              note: `Re-run with --broadcast to submit. Ensure the wallet holds a little POL or USDC for gas.`
            },
            bigintReplacer,
            2
          )
        );
        return;
      }

      const result = await runDappClientTx({
        walletName,
        chainId,
        transactions,
        broadcast,
        preferNativeFee: false
      });

      console.log(
        JSON.stringify(
          {
            ok: true,
            walletName,
            walletAddress,
            chainId,
            chain: network.name,
            kind,
            ...summary,
            txHash: result.txHash,
            explorerUrl: getExplorerUrl(network, result.txHash ?? '')
          },
          bigintReplacer,
          2
        )
      );
    } catch (error) {
      console.error(JSON.stringify(failureJson(error), bigintReplacer, 2));
      process.exit(1);
    }
  }
};

// A preview of an x402 payment (dry-run mode): the price, where it goes and the
// transfer that would fund it. Nothing is sent or reserved.
function printX402Preview(params: {
  walletName: string;
  walletAddress: string;
  signerAddress?: string;
  url: string;
  method: string;
  priceUsd: number;
  payment: Record<string, unknown>;
  transactions: Array<{ to: string; value: bigint; data: string }>;
}): void {
  const { signerAddress, ...rest } = params;
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun: true,
        ...rest,
        ...(signerAddress ? { signerAddress } : {}),
        note: 'Payment not sent. Re-run with --broadcast or set `agent mode auto` to execute.'
      },
      bigintReplacer,
      2
    )
  );
}

// --- x402-pay ---
// A response body: parsed JSON when it parses, else the text. A malformed body
// must not hide what was paid.
// A paid request holds the x402 lock, so it must not hang forever.
const PAID_REQUEST_TIMEOUT_MS = 120_000;

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const x402PayCommand: CommandModule = {
  command: 'x402-pay',
  describe: 'Call x402-protected resource (preview by default)',
  builder: (yargs) =>
    withWriteFlags(
      withWalletAndChain(yargs)
        .option('url', {
          type: 'string',
          demandOption: true,
          describe: 'URL to call',
          coerce: fileCoerce
        })
        .option('method', {
          type: 'string',
          default: 'GET',
          describe: 'HTTP method'
        })
        .option('body', {
          type: 'string',
          describe: 'Request body (JSON)',
          coerce: fileCoerce
        })
        .option('header', {
          type: 'string',
          array: true,
          describe: 'Additional header (Key:Value), repeatable'
        })
        .option('max-usd', {
          type: 'number',
          describe: 'Refuse to pay more than this (USD)'
        })
        .option('yes', {
          type: 'boolean',
          default: false,
          describe: 'Pay a price over x402_max_per_call (after the user agreed)'
        })
    ),
  handler: async (argv) => {
    const walletName = (argv.wallet as string) || 'main';
    const url = argv.url as string;
    const maxUsd = argv['max-usd'] as number | undefined;
    const yes = argv.yes === true;
    if (maxUsd !== undefined && (!Number.isFinite(maxUsd) || maxUsd < 0)) {
      console.error(
        JSON.stringify({
          ok: false,
          code: 'invalid_input',
          error: '--max-usd must be a USD amount (0 or more).'
        })
      );
      process.exit(1);
    }
    const method = ((argv.method as string) || 'GET').toUpperCase();
    const body = argv.body as string | undefined;
    const headerArgs = (argv.header as string[]) || [];
    const broadcast = resolveBroadcast(argv as { broadcast?: boolean; dryRun?: boolean });

    try {
      const session = await loadOmsWalletPointer(walletName);
      if (!session) throw new Error(`Wallet not found: ${walletName}. Run: agent wallet login`);
      // The x402 signer EOA comes with this install's Builder setup.
      await ensureBuilderAccess(session.walletAddress);
      const builderConfig = await loadBuilderConfig();
      if (!builderConfig?.privateKey) throw new Error('Builder EOA not found. Run: agent setup');

      const { privateKeyToAccount } = await import('viem/accounts');
      const { wrapFetchWithPayment, x402Client, x402HTTPClient, decodePaymentResponseHeader } =
        await import('@x402/fetch');
      const { ExactEvmScheme } = await import('@x402/evm');

      const eoaAccount = privateKeyToAccount(builderConfig.privateKey as `0x${string}`);

      const probe = await fetch(url, {
        method,
        body: body || undefined,
        headers: (() => {
          const h: Record<string, string> = {};
          for (const hdr of headerArgs) {
            const idx = hdr.indexOf(':');
            if (idx > 0) h[hdr.slice(0, idx).trim()] = hdr.slice(idx + 1).trim();
          }
          return Object.keys(h).length ? h : undefined;
        })()
      });
      if (probe.status !== 402) {
        const data = await readBody(probe);
        console.log(JSON.stringify({ ok: probe.ok, status: probe.status, data }));
        return;
      }

      const headers: Record<string, string> = {};
      for (const h of headerArgs) {
        const idx = h.indexOf(':');
        if (idx > 0) headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
      }

      // Detect custom payment_details format (e.g. x402-api.onrender.com)
      // vs standard x402 X-PAYMENT-REQUIRED header format.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let probeBody: any = null;
      try {
        probeBody = await probe.clone().json();
      } catch {
        // not JSON — fall through to standard x402
      }

      // x402 Bazaar payment format — specific to x402-api.onrender.com.
      // Not a general x402 standard; do not apply to other endpoints.
      const isX402Bazaar = new URL(url).hostname === 'x402-api.onrender.com';
      if (isX402Bazaar && isBazaarBody(probeBody)) {
        const payment = parseBazaarPayment({
          body: probeBody,
          chainId: argv.chain ? resolveNetwork(String(argv.chain)).chainId : undefined
        });
        const payChain = payment.chain;
        const payChainId = payment.chainId;
        const payRecipient = payment.recipient;
        const usdcContract = payment.asset;
        const amountUsdc = payment.usd;
        const priceUsd = payment.usd;
        const transferData = payment.data;
        if (!broadcast) {
          printX402Preview({
            walletName,
            walletAddress: session.walletAddress,
            url,
            method,
            priceUsd,
            payment: {
              format: 'bazaar',
              chain: payChain,
              chainId: payChainId,
              recipient: payRecipient,
              amount: amountUsdc,
              asset: usdcContract
            },
            transactions: [{ to: usdcContract, value: 0n, data: transferData }]
          });
          return;
        }
        // The transfer is the payment itself: a refusal raised after a session
        // transfer was recorded (e.g. while polling it) may still have paid.
        await withX402Lock({
          fn: async () => {
            const recordedBefore = new Set(
              session.access === 'session' ? listTransfers(walletName).map((r) => r.id) : []
            );
            const { funded: fundResult } = await reserveX402Payment({
              walletName,
              url,
              usd: priceUsd,
              maxUsd,
              yes,
              sentAnything: () =>
                session.access === 'session' &&
                listTransfers(walletName).some(
                  (r) =>
                    !recordedBefore.has(r.id) && !(r.state === 'failed' && r.neverSent === true)
                ),
              fund: () => {
                process.stderr.write(
                  `Sending ${amountUsdc} USDC to ${payRecipient} on ${payChain}...\n`
                );
                return runDappClientTx({
                  walletName,
                  chainId: payChainId,
                  transactions: [{ to: usdcContract, value: 0n, data: transferData }],
                  broadcast: true,
                  purpose: 'x402',
                  ref: url
                });
              }
            });
            const payTxHash = fundResult.txHash;
            if (!payTxHash) throw new Error('The payment returned no transaction hash');
            process.stderr.write(`Paid via tx: ${payTxHash}\n`);

            // Wait for the transaction to be confirmed before presenting to the server
            process.stderr.write('Waiting for confirmation...\n');
            const rpcUrl =
              process.env.SEQUENCE_NODES_URL?.replace('{network}', payChain) ||
              getReadRpcUrl(resolveNetwork(String(payChainId)));
            for (let attempt = 0; attempt < 30; attempt++) {
              await new Promise((r) => setTimeout(r, 3000));
              try {
                const rpcRes = await fetch(rpcUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'eth_getTransactionReceipt',
                    params: [payTxHash]
                  })
                });
                const rpcData = (await rpcRes.json()) as { result?: { status?: string } | null };
                if (rpcData.result?.status === '0x1') {
                  process.stderr.write('Transaction confirmed.\n');
                  break;
                }
              } catch {
                // ignore RPC errors, keep polling
              }
            }

            const retryHeaders: Record<string, string> = {
              ...headers,
              'X-Payment-TxHash': payTxHash,
              'X-Payment-Chain': payChain
            };
            if (body) retryHeaders['Content-Type'] = 'application/json';

            let response: Response;
            try {
              response = await fetch(url, {
                method,
                headers: retryHeaders,
                body: body || undefined,
                signal: AbortSignal.timeout(PAID_REQUEST_TIMEOUT_MS)
              });
            } catch (error) {
              // Paid already: keep that in the output, so nobody pays again.
              console.error(
                JSON.stringify(
                  {
                    ok: false,
                    code: 'upstream_error',
                    error: `Paid ${x402UsdText(priceUsd)} (tx ${payTxHash}), but the service didn't answer (${error instanceof Error ? error.message : String(error)}). Don't pay again: retry the request with the payment headers below.`,
                    walletAddress: session.walletAddress,
                    paidUsd: priceUsd,
                    funded: { amount: amountUsdc, asset: usdcContract, txHash: payTxHash },
                    retryHeaders: { 'X-Payment-TxHash': payTxHash, 'X-Payment-Chain': payChain }
                  },
                  null,
                  2
                )
              );
              process.exit(1);
            }

            const data = await readBody(response);

            console.log(
              JSON.stringify(
                {
                  ok: response.ok,
                  status: response.status,
                  walletAddress: session.walletAddress,
                  paidUsd: priceUsd,
                  ...(response.ok
                    ? {}
                    : {
                        error: `Paid ${x402UsdText(priceUsd)}, but the service returned ${response.status}. x402 has no refunds.`
                      }),
                  funded: { amount: amountUsdc, asset: usdcContract, txHash: payTxHash },
                  data
                },
                null,
                2
              )
            );

            if (!response.ok) process.exit(1);
          }
        });
        return;
      }

      // Standard x402 flow: EIP-3009 signed payment via facilitator
      const httpClient = new x402HTTPClient(new x402Client());
      const paymentRequired = httpClient.getPaymentRequiredResponse(
        (n: string) => probe.headers.get(n),
        {}
      );
      // Providers may advertise many payment options across chains — testnets
      // and non-standard batched/gateway schemes included — and accepts[0] is
      // not necessarily Polygon (QuickNode, e.g., lists Base Sepolia first).
      // Select the cheapest plain-USDC transfer on the preferred chain (default
      // Polygon 137, or --chain) so we pay ~$0.001 on Polygon, not whatever is
      // first. The same selector is handed to the payment client below so the
      // funded amount/asset/chain match what actually gets paid.
      const chainArg = argv.chain as string | undefined;
      let preferredChainId = 137;
      if (chainArg) {
        try {
          preferredChainId = resolveNetwork(chainArg).chainId;
        } catch {
          preferredChainId = 137;
        }
      }
      // A plain EIP-3009 transfer (what ExactEvmScheme signs), not a batched /
      // gateway-wallet scheme that uses a different signing domain.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isPlainTransfer = (r: any): boolean => {
        const name = String(r?.extra?.name || '').toLowerCase();
        return !name.includes('gateway') && !name.includes('batched');
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cheapest = (list: any[]): any => {
        // By USD value: raw amounts aren't comparable across decimals (BNB USDC has 18).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const usd = (r: any) =>
          x402PriceUsd({
            chainId: Number(String(r.network).split(':')[1]),
            asset: String(r.asset),
            amount: BigInt(r.amount)
          });
        return [...list].sort((a, b) => usd(a) - usd(b))[0];
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const selectAccept = (_version: number, accepts: any[]): any => {
        // Only what this client can sign: the plain EVM "exact" scheme.
        const signable = (accepts || []).filter(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (r: any) =>
            typeof r?.network === 'string' &&
            r.network.startsWith('eip155:') &&
            r.scheme === 'exact' &&
            isPlainTransfer(r) &&
            // A stablecoin the CLI can value on that chain (else it can't pay).
            findSupportedToken({
              chainId: Number(r.network.split(':')[1]),
              address: String(r.asset)
            })?.kind === 'usd' &&
            // An EIP-3009 authorization; Permit2 needs an allowance the signer lacks.
            (r.extra?.assetTransferMethod === undefined ||
              r.extra?.assetTransferMethod === 'eip3009')
        );
        const preferred = signable.filter((r) => r.network === `eip155:${preferredChainId}`);
        if (preferred.length) return cheapest(preferred);
        if (signable.length) return cheapest(signable);
        return undefined;
      };

      const req = selectAccept(paymentRequired.x402Version ?? 2, paymentRequired.accepts);
      if (!req) {
        throw new CliError({
          code: 'invalid_input',
          message:
            "The service offers no payment option the CLI can sign (a plain 'exact' transfer on an EVM chain); nothing was paid."
        });
      }

      const { amount, asset, network: paymentNetwork } = req;

      // Pay on the chain the selected requirement names; a different --chain
      // only steers the choice, it never redirects the payment.
      const chainFromPayment =
        typeof paymentNetwork === 'string' && paymentNetwork.startsWith('eip155:')
          ? Number(paymentNetwork.split(':')[1])
          : NaN;
      if (!Number.isInteger(chainFromPayment)) {
        throw new CliError({
          code: 'invalid_input',
          message: `The service asks for payment on ${String(paymentNetwork)}, which isn't an EVM chain the CLI pays on.`
        });
      }
      const resolvedNetwork = resolveNetwork(chainFromPayment);
      if (chainArg && resolveNetwork(chainArg).chainId !== resolvedNetwork.chainId) {
        throw new CliError({
          code: 'invalid_input',
          message: `The service doesn't take payment on ${chainArg}; its cheapest option is on ${resolvedNetwork.name}.`,
          hint: 'Drop --chain, or pick a chain the service supports.'
        });
      }
      if (!isAddress(asset)) {
        throw new CliError({
          code: 'invalid_input',
          message: `Not a token address: ${String(asset)}`
        });
      }
      const fundAmount = BigInt(amount);
      const priceUsd = x402PriceUsd({
        chainId: resolvedNetwork.chainId,
        asset,
        amount: fundAmount
      });
      if (!broadcast) {
        // The full price as the funding transfer: funds the signer already
        // holds are counted only when paying.
        printX402Preview({
          walletName,
          walletAddress: session.walletAddress,
          signerAddress: eoaAccount.address,
          url,
          method,
          priceUsd,
          payment: {
            format: 'x402',
            amount,
            asset,
            network: paymentNetwork,
            chainId: resolvedNetwork.chainId
          },
          transactions: [
            {
              to: asset,
              value: 0n,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: 'transfer',
                args: [eoaAccount.address, fundAmount]
              })
            }
          ]
        });
        return;
      }

      await withX402Lock({
        fn: async () => {
          const signerFunds = () =>
            readTokenBalance({
              chainId: resolvedNetwork.chainId,
              token: asset,
              owner: eoaAccount.address
            });
          // Read under the x402 lock (inside fund), so two calls can't both count
          // on the same leftover.
          let signerBalance = 0n;
          // What the wallet tops the signer up by.
          let shortfall = 0n;

          // Funds left in the signer by an earlier call that wasn't settled pay
          // first; the wallet funds only the shortfall.
          const { reservationId, funded: fundResult } = await reserveX402Payment({
            walletName,
            url,
            usd: priceUsd,
            maxUsd,
            yes,
            fund: async (): Promise<{ txHash?: string }> => {
              signerBalance = await signerFunds();
              // Funds an earlier, unconfirmed authorization may still claim aren't free.
              const promised = pendingAuthorizations({
                chainId: resolvedNetwork.chainId,
                asset,
                now: new Date()
              });
              const free = signerBalance > promised ? signerBalance - promised : 0n;
              shortfall = fundAmount > free ? fundAmount - free : 0n;
              if (shortfall === 0n) return { txHash: undefined };
              process.stderr.write(
                `Funding EOA ${eoaAccount.address} with ${shortfall} units of ${asset}...\n`
              );
              const result = await runDappClientTx({
                walletName,
                chainId: resolvedNetwork.chainId,
                transactions: [
                  {
                    to: asset,
                    value: 0n,
                    data: encodeFunctionData({
                      abi: erc20Abi,
                      functionName: 'transfer',
                      args: [eoaAccount.address, shortfall]
                    })
                  }
                ],
                broadcast: true,
                preferNativeFee: true,
                purpose: 'x402',
                ref: url
              });
              return { txHash: result.txHash };
            }
          });
          if (fundResult.txHash) {
            process.stderr.write(`Funded via tx: ${fundResult.txHash}\n`);
            try {
              await waitForSignerFunds({
                chainId: resolvedNetwork.chainId,
                token: asset,
                owner: eoaAccount.address,
                // The balance the top-up produces, not just enough for this
                // payment: funds promised to earlier authorizations don't count.
                atLeast: signerBalance + shortfall
              });
            } catch (error) {
              // Nothing was signed, so the service can't have been paid.
              releaseX402Reservation(reservationId);
              throw error;
            }
          }

          // On the paid request, sign only the requirement that was valued and
          // funded: same network, asset and scheme, for no more than that amount.
          const selectValued: SelectPaymentRequirements = (_version, accepts) => {
            const match = accepts.find(
              (r) =>
                r.network === req.network &&
                r.scheme === req.scheme &&
                r.payTo.toLowerCase() === String(req.payTo).toLowerCase() &&
                r.asset.toLowerCase() === String(req.asset).toLowerCase() &&
                BigInt(r.amount || 0) <= fundAmount
            );
            if (!match) {
              throw new Error(
                'The service changed its payment terms after they were checked; it was not paid more.'
              );
            }
            return match;
          };

          // The library's own caps ($1, its token list) are off: the CLI has valued
          // and limited this payment already, and selectValued holds it to that.
          const client = new x402Client(selectValued).setSpendControls(false);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          client.register('eip155:*', new ExactEvmScheme(eoaAccount as any));
          // A signed authorization can settle until it expires, whatever the
          // service answers; until then the signer funds it covers aren't free.
          // Recorded from what was actually signed, before it's sent (if it
          // can't be recorded, the hook throws and nothing is sent). `sent`
          // means signed and recorded, so possibly sent: from then on the
          // payment counts as made unless the service confirms otherwise.
          let sent = false;
          client.onAfterPaymentCreation(async ({ paymentPayload }) => {
            const signedAuth = signedAuthorization(paymentPayload);
            if (signedAuth.amount > fundAmount) {
              throw new Error('The signed amount is more than was valued; it was not sent.');
            }
            markAuthorizationPending({
              id: reservationId,
              chainId: resolvedNetwork.chainId,
              asset,
              amount: signedAuth.amount,
              until: new Date(signedAuth.validBefore.getTime() + 60_000)
            });
            sent = true;
          });
          const fetchWithPayment = wrapFetchWithPayment(fetch, client);

          // Ensure a JSON body is parseable upstream: set Content-Type when a body is
          // present and the caller didn't specify one (mirrors the bazaar path).
          // Without this, proxied POST services reject the body ("expected object").
          const retryHeaders: Record<string, string> = { ...headers };
          if (body && !Object.keys(retryHeaders).some((h) => h.toLowerCase() === 'content-type')) {
            retryHeaders['Content-Type'] = 'application/json';
          }

          let response: Response;
          try {
            response = await fetchWithPayment(url, {
              signal: AbortSignal.timeout(PAID_REQUEST_TIMEOUT_MS),
              method,
              headers: Object.keys(retryHeaders).length ? retryHeaders : undefined,
              body: body || undefined
            });
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            // Nothing signed and sent yet (or refused before that): certainly
            // unpaid. After that, the payment may have reached the service, so
            // it stays counted.
            const unsent = !sent;
            if (unsent) releaseX402Reservation(reservationId);
            console.error(
              JSON.stringify(
                {
                  ok: false,
                  code: 'upstream_error',
                  error: unsent
                    ? `The paid request failed before paying (${reason}). The ${x402UsdText(priceUsd)} stays in the signer ${eoaAccount.address} and pays for a later call.`
                    : `The paid request failed (${reason}). The payment may or may not have reached the service: the ${x402UsdText(priceUsd)} is either with the service or still in the signer ${eoaAccount.address}.`,
                  walletAddress: session.walletAddress,
                  signerAddress: eoaAccount.address,
                  paidUsd: unsent ? 0 : null,
                  ...(unsent ? {} : { paymentUncertain: true }),
                  funded: { amount, asset, txHash: fundResult.txHash }
                },
                bigintReplacer,
                2
              )
            );
            process.exit(1);
          }

          const paymentResponseHeader =
            response.headers.get('PAYMENT-RESPONSE') || response.headers.get('X-PAYMENT-RESPONSE');
          let payment = null;
          if (paymentResponseHeader) {
            try {
              payment = decodePaymentResponseHeader(paymentResponseHeader);
            } catch {
              // ignore
            }
          }

          const data = await readBody(response);

          // Paid: a settlement that says so, or a success after sending. Unpaid:
          // nothing was signed and sent. A sent authorization the service says it
          // didn't settle can still settle until it expires, so it stays counted
          // against the daily limit, its funds stay set aside, and it's reported
          // as uncertain.
          const paid = sent && (payment?.success === true || (response.ok && !payment));
          const unpaid = !sent;
          if (unpaid) releaseX402Reservation(reservationId);
          // Only a confirmed settlement frees the set-aside funds.
          if (paid && payment?.success === true) settleAuthorizationPending(reservationId);
          const uncertain = !paid && !unpaid;
          const reportedUnsettled =
            uncertain && (payment ? payment.success !== true : response.status === 402);

          console.log(
            JSON.stringify(
              {
                ok: response.ok,
                status: response.status,
                walletAddress: session.walletAddress,
                signerAddress: eoaAccount.address,
                paidUsd: paid ? priceUsd : uncertain ? null : 0,
                ...(uncertain ? { paymentUncertain: true } : {}),
                ...(response.ok
                  ? {}
                  : paid
                    ? {
                        error: `Paid ${x402UsdText(priceUsd)}, but the service returned ${response.status}. x402 has no refunds.`
                      }
                    : unpaid
                      ? {
                          error: `The service returned ${response.status} before anything was signed. The ${x402UsdText(priceUsd)} stays in the signer ${eoaAccount.address} and pays for a later call.`
                        }
                      : reportedUnsettled
                        ? {
                            error: `The service returned ${response.status} and says it didn't settle the payment. The signed authorization can still be settled until it expires, so the ${x402UsdText(priceUsd)} stays counted against the daily limit; if it isn't, the funds stay in the signer ${eoaAccount.address} for a later call.`
                          }
                        : {
                            error: `The service returned ${response.status} without saying whether it took the payment. The ${x402UsdText(priceUsd)} is either with the service or still in the signer ${eoaAccount.address}.`
                          }),
                funded: {
                  amount,
                  asset,
                  txHash: fundResult.txHash ?? null,
                  fromSignerBalance: signerBalance > 0n
                },
                payment: payment
                  ? {
                      settled: payment.success === true,
                      transaction: payment.transaction,
                      ...(payment.errorReason ? { errorReason: payment.errorReason } : {})
                    }
                  : null,
                data
              },
              null,
              2
            )
          );

          if (!response.ok) process.exit(1);
        }
      });
    } catch (error) {
      console.error(JSON.stringify(failureJson(error), bigintReplacer, 2));
      process.exit(1);
    }
  }
};

import type { CommandModule, Argv } from 'yargs';

import { runDappClientTx } from '../lib/dapp-client.ts';
import { loadWalletSession, loadBuilderConfig } from '../lib/storage.ts';
import { resolveErc20BySymbol } from '../lib/token-directory.ts';
import {
  resolveNetwork,
  formatUnits,
  parseUnits,
  getExplorerUrl,
  fileCoerce
} from '../lib/utils.ts';

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

function withBroadcast<T>(yargs: Argv<T>) {
  return yargs.option('broadcast', {
    type: 'boolean' as const,
    default: false,
    describe: 'Execute transaction (dry-run by default)'
  });
}

// Get per-chain indexer URL
function getChainIndexerUrl(chainId: number): string {
  const chainNames: Record<number, string> = {
    137: 'polygon',
    80002: 'amoy',
    1: 'mainnet',
    42161: 'arbitrum',
    10: 'optimism',
    8453: 'base',
    43114: 'avalanche',
    56: 'bsc',
    100: 'gnosis'
  };
  const name = chainNames[chainId] || 'polygon';
  return `https://${name}-indexer.sequence.app`;
}

// Load optional token map override from env
function loadTokenMap(): Record<string, Record<string, { address: string; decimals: number }>> {
  const raw = process.env.TRAILS_TOKEN_MAP_JSON || '';
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid TRAILS_TOKEN_MAP_JSON (must be valid JSON)');
  }
}

// Helper: Get token configuration (native or ERC20)
async function getTokenConfig({
  chainId,
  symbol,
  nativeSymbol
}: {
  chainId: number;
  symbol: string;
  nativeSymbol: string;
}): Promise<{ symbol: string; address: string; decimals: number }> {
  const sym = String(symbol || '')
    .toUpperCase()
    .trim();

  if (sym === 'NATIVE' || sym === nativeSymbol.toUpperCase() || sym === 'POL' || sym === 'MATIC') {
    return {
      symbol: nativeSymbol.toUpperCase(),
      address: '0x0000000000000000000000000000000000000000',
      decimals: 18
    };
  }

  const tokenMap = loadTokenMap();
  const entry = tokenMap?.[String(chainId)]?.[sym];
  if (entry?.address && entry.decimals != null) {
    return {
      symbol: sym,
      address: entry.address,
      decimals: Number(entry.decimals)
    };
  }

  const token = await resolveErc20BySymbol({ chainId, symbol: sym });
  if (!token?.address || token.decimals == null) {
    throw new Error(`Unknown token ${sym} on chainId=${chainId}`);
  }

  return {
    symbol: sym,
    address: token.address,
    decimals: Number(token.decimals)
  };
}

const bigintReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

// --- balances ---
export const balancesCommand: CommandModule = {
  command: 'balances',
  describe: 'Check token balances',
  builder: (yargs) => withWalletAndChain(yargs),
  handler: async (argv) => {
    const walletName = argv.wallet as string;

    try {
      const session = await loadWalletSession(walletName);
      if (!session) {
        throw new Error(`Wallet not found: ${walletName}`);
      }

      const indexerKey =
        process.env.SEQUENCE_INDEXER_ACCESS_KEY ||
        session.projectAccessKey ||
        process.env.SEQUENCE_PROJECT_ACCESS_KEY;
      if (!indexerKey) {
        throw new Error('Missing project access key (not in wallet session or environment)');
      }

      const network = resolveNetwork((argv.chain as string) || session.chain || 'polygon');
      const nativeDecimals = network.nativeToken?.decimals ?? 18;
      const nativeSymbol = network.nativeToken?.symbol || 'POL';

      const { SequenceIndexer } = await import('@0xsequence/indexer');
      const indexerUrl = getChainIndexerUrl(network.chainId);
      const indexer = new SequenceIndexer(indexerUrl, indexerKey);

      const [nativeRes, tokenRes] = await Promise.all([
        indexer.getNativeTokenBalance({
          accountAddress: session.walletAddress
        }),
        indexer.getTokenBalances({
          accountAddress: session.walletAddress,
          includeMetadata: true
        })
      ]);

      const nativeWei = nativeRes?.balance?.balance || '0';
      const native = [
        {
          type: 'native',
          symbol: nativeSymbol,
          balance: formatUnits(BigInt(nativeWei), nativeDecimals)
        }
      ];

      const erc20 = (tokenRes?.balances || []).map(
        (b: {
          contractInfo?: { symbol?: string; name?: string; decimals?: number };
          contractAddress: string;
          balance?: string;
        }) => ({
          type: 'erc20',
          symbol: b.contractInfo?.symbol || 'ERC20',
          name: b.contractInfo?.name || undefined,
          contractAddress: b.contractAddress,
          balance: formatUnits(b.balance || '0', b.contractInfo?.decimals ?? 18)
        })
      );

      console.log(
        JSON.stringify(
          {
            ok: true,
            walletName,
            walletAddress: session.walletAddress,
            chainId: network.chainId,
            chain: network.name,
            balances: [...native, ...erc20]
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
};

// --- fund ---
export const fundCommand: CommandModule = {
  command: 'fund',
  describe: 'Open Trails widget to fund wallet',
  builder: (yargs) =>
    withWalletAndChain(yargs).option('token', {
      type: 'string',
      describe: 'Fund token address'
    }),
  handler: async (argv) => {
    const walletName = argv.wallet as string;

    try {
      const session = await loadWalletSession(walletName);
      if (!session) {
        throw new Error(`Wallet not found: ${walletName}. Run 'wallet create' first.`);
      }

      const walletAddress = session.walletAddress;
      const chainId = session.chainId || 137;
      const toToken = (argv.token as string) || '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
      const apiKey = process.env.SEQUENCE_PROJECT_ACCESS_KEY || '';

      const fundingUrl = `https://demo.trails.build/?mode=swap&toAddress=${walletAddress}&toChainId=${chainId}&toToken=${toToken}&apiKey=${apiKey}&theme=light`;

      console.log(
        JSON.stringify(
          {
            ok: true,
            walletName,
            walletAddress,
            chainId,
            fundingUrl,
            message: 'Open the funding URL in your browser to fund your wallet via Trails.'
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
};

// --- send ---
export const sendCommand: CommandModule = {
  command: 'send',
  describe: 'Send native token (auto-detect with --symbol for ERC20)',
  builder: (yargs) =>
    withBroadcast(
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
    withBroadcast(
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
  const broadcast = argv.broadcast as boolean;

  try {
    const session = await loadWalletSession(walletName);
    if (!session) {
      throw new Error(`Wallet not found: ${walletName}`);
    }

    const network = resolveNetwork((argv.chain as string) || session.chain || 'polygon');

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

// --- send-token ---
export const sendTokenCommand: CommandModule = {
  command: 'send-token',
  describe: 'Send ERC20 by symbol',
  builder: (yargs) =>
    withBroadcast(
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
  const symbol = argv.symbol as string | undefined;
  const tokenAddress = argv.token as string | undefined;
  const decimalsArg = argv.decimals as number | undefined;
  const to = argv.to as string;
  const amount = argv.amount as string;
  const broadcast = (argv.broadcast as boolean) || false;

  try {
    const session = await loadWalletSession(walletName);
    if (!session) {
      throw new Error(`Wallet not found: ${walletName}`);
    }

    const network = resolveNetwork((argv.chain as string) || session.chain || 'polygon');

    let token = tokenAddress;
    let decimals = decimalsArg ?? null;

    if (symbol) {
      const resolved = await resolveErc20BySymbol({
        chainId: network.chainId,
        symbol
      });
      if (!resolved) {
        throw new Error(`Unknown token symbol: ${symbol} on ${network.name}`);
      }
      token = resolved.address;
      decimals = Number(resolved.decimals);
    }

    if (!token || decimals === null) {
      throw new Error('Provide either --symbol OR (--token + --decimals)');
    }

    const value = parseUnits(amount, decimals);
    const selector = '0xa9059cbb';
    const pad = (hex: string, n = 64) => String(hex).replace(/^0x/, '').padStart(n, '0');
    const data = selector + pad(to) + pad('0x' + value.toString(16));

    const transactions = [
      {
        to: token,
        value: 0n,
        data
      }
    ];

    const result = await runDappClientTx({
      walletName,
      chainId: network.chainId,
      transactions,
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
          symbol: symbol || 'TOKEN',
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

// --- swap ---
export const swapCommand: CommandModule = {
  command: 'swap',
  describe: 'DEX swap via Trails API',
  builder: (yargs) =>
    withBroadcast(
      withWalletAndChain(yargs)
        .option('from', {
          type: 'string',
          demandOption: true,
          describe: 'Source token symbol',
          coerce: fileCoerce
        })
        .option('to', {
          type: 'string',
          demandOption: true,
          describe: 'Destination token symbol',
          coerce: fileCoerce
        })
        .option('amount', {
          type: 'string',
          demandOption: true,
          describe: 'Amount to swap',
          coerce: fileCoerce
        })
        .option('slippage', {
          type: 'number',
          describe: 'Slippage tolerance (0-0.5)'
        })
        .option('to-chain', {
          type: 'string',
          describe: 'Destination chain (for cross-chain swaps)'
        })
    ),
  handler: async (argv) => {
    const walletName = (argv.wallet as string) || 'main';
    const fromSymbol = argv.from as string;
    const toSymbol = argv.to as string;
    const amount = argv.amount as string;
    const slippageArg = argv.slippage as number | undefined;
    const toChainArg = argv['to-chain'] as string | undefined;
    const broadcast = argv.broadcast as boolean;

    try {
      const session = await loadWalletSession(walletName);
      if (!session) {
        throw new Error(`Wallet not found: ${walletName}`);
      }

      const originNetwork = resolveNetwork((argv.chain as string) || session.chain || 'polygon');
      const originChainId = originNetwork.chainId;
      const originNativeSymbol = originNetwork.nativeToken?.symbol || 'NATIVE';

      const destNetwork = toChainArg ? resolveNetwork(toChainArg) : originNetwork;
      const destChainId = destNetwork.chainId;
      const destNativeSymbol = destNetwork.nativeToken?.symbol || 'NATIVE';
      const isCrossChain = destChainId !== originChainId;

      const slippage = slippageArg ?? 0.005;
      if (!Number.isFinite(slippage) || slippage <= 0 || slippage >= 0.5) {
        throw new Error('Invalid --slippage (must be between 0 and 0.5)');
      }

      const fromToken = await getTokenConfig({
        chainId: originChainId,
        symbol: fromSymbol,
        nativeSymbol: originNativeSymbol
      });
      const toToken = await getTokenConfig({
        chainId: destChainId,
        symbol: toSymbol,
        nativeSymbol: destNativeSymbol
      });

      if (!isCrossChain && fromToken.address.toLowerCase() === toToken.address.toLowerCase()) {
        throw new Error('from and to token must be different');
      }

      const { TrailsApi, TradeType } = await import('@0xtrails/api');
      const trailsApiKey =
        process.env.TRAILS_API_KEY ||
        session.projectAccessKey ||
        process.env.SEQUENCE_PROJECT_ACCESS_KEY ||
        '';
      const trails = new TrailsApi(trailsApiKey, {
        hostname: process.env.TRAILS_API_HOSTNAME
      });

      const walletAddress = session.walletAddress;

      const { parseUnits: viemParseUnits } = await import('viem');
      const originTokenAmount = viemParseUnits(amount, fromToken.decimals);

      const quoteReq = {
        ownerAddress: walletAddress,
        originChainId,
        originTokenAddress: fromToken.address,
        originTokenAmount,
        destinationChainId: destChainId,
        destinationTokenAddress: toToken.address,
        destinationTokenAmount: 0n,
        tradeType: TradeType.EXACT_INPUT,
        options: {
          slippageTolerance: slippage
        }
      };

      const quoteRes = await trails.quoteIntent(quoteReq);
      if (!quoteRes?.intent) {
        throw new Error('No intent returned from quoteIntent');
      }

      const intent = quoteRes.intent;

      const commitRes = await trails.commitIntent({ intent });
      const intentId = commitRes?.intentId || intent.intentId;
      if (!intentId) {
        throw new Error('No intentId from commitIntent');
      }

      const depositTx = intent.depositTransaction;
      if (!depositTx?.to) {
        throw new Error('Intent missing depositTransaction');
      }

      const transactions = [
        {
          to: depositTx.to,
          data: depositTx.data || '0x',
          value: depositTx.value ? BigInt(depositTx.value) : 0n
        }
      ];

      if (!broadcast) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              dryRun: true,
              walletName,
              walletAddress,
              intentId,
              fromToken: fromToken.symbol,
              fromChain: originNetwork.name,
              toToken: toToken.symbol,
              toChain: destNetwork.name,
              crossChain: isCrossChain,
              amount,
              depositTransaction: depositTx,
              note: 'Re-run with --broadcast to submit the deposit transaction and execute the intent.'
            },
            bigintReplacer,
            2
          )
        );
        return;
      }

      const result = await runDappClientTx({
        walletName,
        chainId: originChainId,
        transactions,
        broadcast: true,
        preferNativeFee: false
      });
      const txHash = result.txHash ?? '';

      const execRes = await trails.executeIntent({
        intentId,
        depositTransactionHash: txHash
      });

      // Poll for receipt until done or timeout (120s)
      const POLL_INTERVAL_MS = 3000;
      const POLL_TIMEOUT_MS = 120000;
      const pollStart = Date.now();
      let receipt;
      while (true) {
        receipt = await trails.waitIntentReceipt({ intentId });
        if (receipt?.done) break;
        if (Date.now() - pollStart >= POLL_TIMEOUT_MS) {
          console.error(
            JSON.stringify(
              {
                ok: false,
                error: 'Swap intent timed out waiting for completion',
                intentId,
                intentStatus: (receipt as any)?.intentStatus ?? null,
                hint: `Check status manually with intentId: ${intentId}`
              },
              null,
              2
            )
          );
          process.exit(1);
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      const explorerUrl = getExplorerUrl(originNetwork, txHash);
      console.log(
        JSON.stringify(
          {
            ok: true,
            walletName,
            walletAddress,
            fromToken: fromToken.symbol,
            fromChain: originNetwork.name,
            fromChainId: originChainId,
            toToken: toToken.symbol,
            toChain: destNetwork.name,
            toChainId: destChainId,
            crossChain: isCrossChain,
            amount,
            intentId,
            depositTxHash: txHash,
            depositExplorerUrl: explorerUrl,
            executeStatus: execRes?.intentStatus,
            receipt
          },
          bigintReplacer,
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
};

// --- deposit ---
export const depositCommand: CommandModule = {
  command: 'deposit',
  describe: 'Deposit ERC20 to earn yield (Trails earn pools)',
  builder: (yargs) =>
    withBroadcast(
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
    const amountArg = argv.amount as string;
    const protocolFilter = argv.protocol as string | undefined;
    const broadcast = argv.broadcast as boolean;

    try {
      const session = await loadWalletSession(walletName);
      if (!session) throw new Error(`Wallet not found: ${walletName}`);

      const network = resolveNetwork((argv.chain as string) || session.chain || 'polygon');
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
        session.projectAccessKey ||
        process.env.SEQUENCE_PROJECT_ACCESS_KEY ||
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
          `No active earn pools found for ${assetSymbol} on ${network.name}` +
            (protocolFilter ? ` (protocol filter: ${protocolFilter})` : '') +
            `. Try 'polygon-agent swap --from ${assetSymbol} --to <yield-token>' as an alternative.`
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pools.sort((a: any, b: any) => b.tvl - a.tvl);
      const pool = pools[0];
      const proto = (pool.protocol || '').toLowerCase();

      const { encodeFunctionData, parseUnits: viemParseUnits } = await import('viem');
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
            `Supported: aave, morpho. Open an issue or use 'polygon-agent swap' to obtain the yield-bearing token.`
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
              poolApy: `${(pool.apy * 100).toFixed(2)}%`,
              poolTvl: pool.tvl,
              depositAddress: pool.depositAddress,
              asset: assetSymbol,
              amount: amountArg,
              chainId,
              chain: network.name,
              transactions,
              note: `Re-run with --broadcast to submit the deposit. If session rejects the call, re-create with: polygon-agent wallet create --contract ${pool.depositAddress}`
            },
            bigintReplacer,
            2
          )
        );
        return;
      }

      let result;
      try {
        result = await runDappClientTx({
          walletName,
          chainId,
          transactions,
          broadcast,
          preferNativeFee: false
        });
      } catch (txErr) {
        if ((txErr as Error).message?.includes('No signer supported')) {
          throw new Error(
            `Session does not permit calls to ${pool.depositAddress} (${pool.protocol} pool). ` +
              `Re-create the wallet session with: polygon-agent wallet create --contract ${pool.depositAddress}\n` +
              `Original error: ${(txErr as Error).message}`
          );
        }
        throw txErr;
      }

      console.log(
        JSON.stringify(
          {
            ok: true,
            walletName,
            walletAddress,
            protocol: pool.protocol,
            poolName: protocolLabel,
            poolApy: `${(pool.apy * 100).toFixed(2)}%`,
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
};

// --- x402-pay ---
export const x402PayCommand: CommandModule = {
  command: 'x402-pay',
  describe: 'Call x402-protected resource (auto-pays 402)',
  builder: (yargs) =>
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
      }),
  handler: async (argv) => {
    const walletName = (argv.wallet as string) || 'main';
    const url = argv.url as string;
    const method = ((argv.method as string) || 'GET').toUpperCase();
    const body = argv.body as string | undefined;
    const headerArgs = (argv.header as string[]) || [];

    try {
      const [session, builderConfig] = await Promise.all([
        loadWalletSession(walletName),
        loadBuilderConfig()
      ]);
      if (!session) throw new Error(`Wallet not found: ${walletName}`);
      if (!builderConfig?.privateKey)
        throw new Error('Builder EOA not found. Run: polygon-agent setup');

      const { privateKeyToAccount } = await import('viem/accounts');
      const { wrapFetchWithPayment, x402Client, x402HTTPClient, decodePaymentResponseHeader } =
        await import('@x402/fetch');
      const { ExactEvmScheme } = await import('@x402/evm');

      const eoaAccount = privateKeyToAccount(builderConfig.privateKey as `0x${string}`);

      const probe = await fetch(url, { method });
      if (probe.status !== 402) {
        const contentType = probe.headers.get('content-type') || '';
        const data = contentType.includes('application/json')
          ? await probe.json()
          : await probe.text();
        console.log(JSON.stringify({ ok: probe.ok, status: probe.status, data }, null, 2));
        return;
      }

      const httpClient = new x402HTTPClient(new x402Client());
      const paymentRequired = httpClient.getPaymentRequiredResponse(
        (n: string) => probe.headers.get(n),
        {}
      );
      const req = paymentRequired.accepts[0];
      if (!req) throw new Error('No payment requirements in 402 response');

      const { amount, asset, network: paymentNetwork } = req;

      const chainArg = argv.chain as string | undefined;
      const chainFromPayment = paymentNetwork?.startsWith('eip155:')
        ? paymentNetwork.split(':')[1]
        : null;
      const resolvedNetwork = resolveNetwork(
        chainArg || chainFromPayment || session.chain || 'polygon'
      );
      const pad = (hex: string, n = 64) => String(hex).replace(/^0x/, '').padStart(n, '0');
      const transferData =
        '0xa9059cbb' + pad(eoaAccount.address) + pad('0x' + BigInt(amount).toString(16));

      process.stderr.write(
        `Funding EOA ${eoaAccount.address} with ${amount} units of ${asset}...\n`
      );
      const fundResult = await runDappClientTx({
        walletName,
        chainId: resolvedNetwork.chainId,
        transactions: [{ to: asset, value: 0n, data: transferData }],
        broadcast: true,
        preferNativeFee: true
      });
      process.stderr.write(`Funded via tx: ${fundResult.txHash}\n`);

      const client = new x402Client();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.register('eip155:*', new ExactEvmScheme(eoaAccount as any));
      const fetchWithPayment = wrapFetchWithPayment(fetch, client);

      const headers: Record<string, string> = {};
      for (const h of headerArgs) {
        const idx = h.indexOf(':');
        if (idx > 0) headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
      }

      const response = await fetchWithPayment(url, {
        method,
        headers: Object.keys(headers).length ? headers : undefined,
        body: body || undefined
      });

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

      const contentType = response.headers.get('content-type') || '';
      const data = contentType.includes('application/json')
        ? await response.json()
        : await response.text();

      console.log(
        JSON.stringify(
          {
            ok: response.ok,
            status: response.status,
            walletAddress: session.walletAddress,
            signerAddress: eoaAccount.address,
            funded: {
              amount,
              asset,
              txHash: fundResult.txHash
            },
            payment: payment ? { settled: true, transaction: payment.transaction } : null,
            data
          },
          null,
          2
        )
      );

      if (!response.ok) process.exit(1);
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
};

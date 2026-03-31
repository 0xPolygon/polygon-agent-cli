// Polymarket CLI commands
// Architecture: Sequence smart wallet → Polymarket proxy wallet → CLOB
// - `approve`: sets on-chain approvals on proxy wallet (one-time)
// - `clob-buy`: funds proxy wallet from smart wallet, then places CLOB BUY order
// - CLOB orders: maker=proxyWallet, signer=EOA, signatureType=POLY_PROXY

import type { CommandModule } from 'yargs';

import { runDappClientTx } from '../lib/dapp-client.ts';
import {
  getMarkets,
  getMarket,
  getOpenOrders,
  cancelOrder,
  createAndPostOrder,
  createAndPostMarketOrder,
  getPolymarketProxyWalletAddress,
  executeViaProxyWallet,
  getPositions,
  USDC_E,
  CTF,
  CTF_EXCHANGE,
  NEG_RISK_CTF_EXCHANGE,
  NEG_RISK_ADAPTER
} from '../lib/polymarket.ts';
import { loadWalletSession, savePolymarketKey, loadPolymarketKey } from '../lib/storage.ts';

// ─── handlers ────────────────────────────────────────────────────────────────

async function handleMarkets(argv: {
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<void> {
  try {
    const markets = await getMarkets({
      search: argv.search,
      limit: argv.limit ?? 20,
      offset: argv.offset ?? 0
    });
    console.log(JSON.stringify({ ok: true, count: markets.length, markets }));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: (err as Error).message }));
    process.exit(1);
  }
}

async function handleMarket(argv: { conditionId: string }): Promise<void> {
  try {
    const market = await getMarket(argv.conditionId);
    console.log(JSON.stringify({ ok: true, market }));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: (err as Error).message }));
    process.exit(1);
  }
}

async function handleSetKey(argv: { privateKey: string }): Promise<void> {
  const pk = argv.privateKey.startsWith('0x') ? argv.privateKey : `0x${argv.privateKey}`;

  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    console.error(
      JSON.stringify(
        { ok: false, error: 'Invalid private key — must be 32 bytes (64 hex chars)' },
        null,
        2
      )
    );
    process.exit(1);
  }

  try {
    const { privateKeyToAccount } = await import('viem/accounts');
    const account = privateKeyToAccount(pk as `0x${string}`);
    const proxyWalletAddress = await getPolymarketProxyWalletAddress(account.address);

    await savePolymarketKey(pk);

    console.log(
      JSON.stringify(
        {
          ok: true,
          eoaAddress: account.address,
          proxyWalletAddress,
          note: 'Polymarket signing key saved (encrypted). All polymarket commands will use this EOA. Remember to accept Polymarket ToS at polymarket.com with this address.'
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: (err as Error).message }));
    process.exit(1);
  }
}

async function handleProxyWallet(): Promise<void> {
  try {
    const privateKey = await loadPolymarketKey();
    const { privateKeyToAccount } = await import('viem/accounts');
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const proxyWalletAddress = await getPolymarketProxyWalletAddress(account.address);

    console.log(
      JSON.stringify(
        {
          ok: true,
          eoaAddress: account.address,
          proxyWalletAddress,
          note: 'Fund proxyWalletAddress with USDC.e on Polygon to enable CLOB trading.'
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: (err as Error).message }));
    process.exit(1);
  }
}

async function handleApprove(argv: { negRisk?: boolean; broadcast?: boolean }): Promise<void> {
  const negRisk = argv.negRisk ?? false;
  const broadcast = argv.broadcast ?? false;

  try {
    const privateKey = await loadPolymarketKey();
    const { privateKeyToAccount } = await import('viem/accounts');
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const proxyWalletAddress = await getPolymarketProxyWalletAddress(account.address);

    const MAX_UINT256 = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    const pad = (val: string, n = 64) => val.replace(/^0x/, '').padStart(n, '0');
    const erc20Approve = (token: string, spender: string, amount: string) => ({
      typeCode: 1,
      to: token,
      value: '0',
      data: '0x095ea7b3' + pad(spender) + pad(amount)
    });
    const erc1155ApproveAll = (token: string, operator: string) => ({
      typeCode: 1,
      to: token,
      value: '0',
      data: '0xa22cb465' + pad(operator) + pad('0x01')
    });

    let txBatch;
    let approvalLabels: string[];
    if (negRisk) {
      txBatch = [
        erc20Approve(USDC_E, NEG_RISK_ADAPTER, MAX_UINT256),
        erc20Approve(USDC_E, NEG_RISK_CTF_EXCHANGE, MAX_UINT256),
        erc1155ApproveAll(CTF, CTF_EXCHANGE),
        erc1155ApproveAll(CTF, NEG_RISK_CTF_EXCHANGE),
        erc1155ApproveAll(CTF, NEG_RISK_ADAPTER)
      ];
      approvalLabels = [
        'USDC.e → NEG_RISK_ADAPTER',
        'USDC.e → NEG_RISK_CTF_EXCHANGE',
        'CTF → CTF_EXCHANGE',
        'CTF → NEG_RISK_CTF_EXCHANGE',
        'CTF → NEG_RISK_ADAPTER'
      ];
    } else {
      txBatch = [
        erc20Approve(USDC_E, CTF_EXCHANGE, MAX_UINT256),
        erc1155ApproveAll(CTF, CTF_EXCHANGE)
      ];
      approvalLabels = ['USDC.e → CTF_EXCHANGE', 'CTF → CTF_EXCHANGE'];
    }

    if (!broadcast) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            dryRun: true,
            proxyWalletAddress,
            signerAddress: account.address,
            negRisk,
            approvals: approvalLabels,
            note: 'Re-run with --broadcast to execute. EOA must have POL for gas.'
          },
          null,
          2
        )
      );
      return;
    }

    const { createWalletClient, createPublicClient, http } = await import('viem');
    const { polygon } = await import('viem/chains');
    const walletClient = createWalletClient({ account, chain: polygon, transport: http() });
    const publicClient = createPublicClient({ chain: polygon, transport: http() });

    process.stderr.write(
      `[polymarket] Setting ${txBatch.length} approvals on proxy wallet ${proxyWalletAddress}...\n`
    );
    const approveTxHash = await executeViaProxyWallet(
      walletClient,
      publicClient,
      proxyWalletAddress,
      txBatch
    );
    process.stderr.write(`[polymarket] Approvals set: ${approveTxHash}\n`);

    console.log(
      JSON.stringify(
        {
          ok: true,
          proxyWalletAddress,
          signerAddress: account.address,
          negRisk,
          approveTxHash,
          note: 'Proxy wallet approvals set. Ready for clob-buy and sell.'
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error(
      JSON.stringify(
        { ok: false, error: (err as Error).message, stack: (err as Error).stack },
        null,
        2
      )
    );
    process.exit(1);
  }
}

async function handleClobBuy(argv: {
  conditionId: string;
  outcome: string;
  amount: number;
  wallet?: string;
  price?: number;
  fak?: boolean;
  skipFund?: boolean;
  broadcast?: boolean;
}): Promise<void> {
  const conditionId = argv.conditionId;
  const outcomeArg = argv.outcome.toUpperCase();
  const amountUsd = argv.amount;
  const walletName = argv.wallet ?? 'main';
  const priceArg = argv.price;
  const useFak = argv.fak ?? false;
  const skipFund = argv.skipFund ?? false;
  const broadcast = argv.broadcast ?? false;

  if (!['YES', 'NO'].includes(outcomeArg)) {
    console.error(JSON.stringify({ ok: false, error: 'Outcome must be YES or NO' }));
    process.exit(1);
  }

  try {
    const market = await getMarket(conditionId);
    const tokenId = outcomeArg === 'YES' ? market.yesTokenId : market.noTokenId;
    if (!tokenId)
      throw new Error(`Market ${conditionId} has no tokenIds (may be closed or invalid)`);

    const currentPrice = outcomeArg === 'YES' ? market.yesPrice : market.noPrice;
    const orderType = priceArg ? 'GTC' : useFak ? 'FAK' : 'FOK';

    if (!broadcast) {
      let proxyWalletAddress: string | null = null;
      try {
        const { privateKeyToAccount } = await import('viem/accounts');
        const pk = await loadPolymarketKey();
        proxyWalletAddress = await getPolymarketProxyWalletAddress(
          privateKeyToAccount(pk as `0x${string}`).address
        );
      } catch {
        /* ignore */
      }

      console.log(
        JSON.stringify(
          {
            ok: true,
            dryRun: true,
            conditionId,
            question: market.question,
            outcome: outcomeArg,
            tokenId,
            currentPrice,
            amountUsd,
            orderType,
            price: priceArg ?? 'market',
            proxyWalletAddress,
            flow: skipFund
              ? ['Place CLOB BUY order (using existing proxy wallet USDC.e balance)']
              : [
                  `Smart wallet (${walletName}) → fund proxy wallet with ${amountUsd} USDC.e`,
                  'Place CLOB BUY order (maker=proxyWallet, signatureType=POLY_PROXY)'
                ],
            note: 'Requires proxy wallet approvals — run `polymarket approve --broadcast` once first. Re-run with --broadcast to execute.'
          },
          null,
          2
        )
      );
      return;
    }

    const [session, privateKey] = await Promise.all([
      loadWalletSession(walletName),
      loadPolymarketKey()
    ]);
    if (!session) throw new Error(`Wallet not found: ${walletName}`);

    const { privateKeyToAccount } = await import('viem/accounts');
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const proxyWalletAddress = await getPolymarketProxyWalletAddress(account.address);
    process.stderr.write(
      `[polymarket] CLOB BUY ${amountUsd} USDC → ${outcomeArg} via proxy wallet ${proxyWalletAddress}\n`
    );

    let fundTxHash: string | null = null;
    if (skipFund) {
      process.stderr.write(`[polymarket] --skip-fund: using existing proxy wallet balance\n`);
    } else {
      process.stderr.write(
        `[polymarket] Funding proxy wallet ${proxyWalletAddress} with ${amountUsd} USDC.e...\n`
      );
      const amountUnits = BigInt(Math.round(amountUsd * 1e6));
      const pad = (hex: string, n = 64) => String(hex).replace(/^0x/, '').padStart(n, '0');
      const transferData =
        '0xa9059cbb' + pad(proxyWalletAddress) + pad('0x' + amountUnits.toString(16));
      const fundResult = await runDappClientTx({
        walletName,
        chainId: 137,
        transactions: [{ to: USDC_E, value: 0n, data: transferData }],
        broadcast: true,
        preferNativeFee: false
      });
      fundTxHash = fundResult.txHash ?? null;
      process.stderr.write(`[polymarket] Funded: ${fundTxHash}\n`);
    }

    let orderResult;
    if (priceArg) {
      const estimatedShares = amountUsd / priceArg;
      orderResult = await createAndPostOrder({
        tokenId,
        side: 'BUY',
        size: estimatedShares,
        price: priceArg,
        orderType: 'GTC',
        privateKey,
        proxyWalletAddress
      });
    } else {
      orderResult = await createAndPostMarketOrder({
        tokenId,
        side: 'BUY',
        amount: amountUsd,
        orderType,
        privateKey,
        proxyWalletAddress
      });
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          conditionId,
          question: market.question,
          outcome: outcomeArg,
          amountUsd,
          currentPrice,
          proxyWalletAddress,
          signerAddress: account.address,
          fundTxHash,
          orderId: orderResult?.orderId || orderResult?.orderID || orderResult?.id || null,
          orderType,
          orderStatus: orderResult?.status || null
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error(
      JSON.stringify(
        { ok: false, error: (err as Error).message, stack: (err as Error).stack },
        null,
        2
      )
    );
    process.exit(1);
  }
}

async function handleSell(argv: {
  conditionId: string;
  outcome: string;
  shares: number;
  price?: number;
  fak?: boolean;
  broadcast?: boolean;
}): Promise<void> {
  const conditionId = argv.conditionId;
  const outcomeArg = argv.outcome.toUpperCase();
  const shares = argv.shares;
  const priceArg = argv.price;
  const useFak = argv.fak ?? false;
  const broadcast = argv.broadcast ?? false;

  if (!['YES', 'NO'].includes(outcomeArg)) {
    console.error(JSON.stringify({ ok: false, error: 'Outcome must be YES or NO' }));
    process.exit(1);
  }

  try {
    const market = await getMarket(conditionId);
    const tokenId = outcomeArg === 'YES' ? market.yesTokenId : market.noTokenId;
    if (!tokenId)
      throw new Error(`Market ${conditionId} has no tokenIds (may be closed or invalid)`);

    const currentPrice = outcomeArg === 'YES' ? market.yesPrice : market.noPrice;
    const estimatedUsd = shares * (currentPrice || 0);

    if (!broadcast) {
      let proxyWalletAddress: string | null = null;
      try {
        const { privateKeyToAccount } = await import('viem/accounts');
        const pk = await loadPolymarketKey();
        proxyWalletAddress = await getPolymarketProxyWalletAddress(
          privateKeyToAccount(pk as `0x${string}`).address
        );
      } catch {
        /* ignore */
      }

      console.log(
        JSON.stringify(
          {
            ok: true,
            dryRun: true,
            conditionId,
            question: market.question,
            outcome: outcomeArg,
            tokenId,
            shares,
            currentPrice,
            estimatedUsd: Math.round(estimatedUsd * 100) / 100,
            orderType: priceArg ? 'GTC' : useFak ? 'FAK' : 'FOK',
            price: priceArg ?? 'market',
            proxyWalletAddress,
            note: 'Direct CLOB SELL of existing position. Tokens must be in proxy wallet. Re-run with --broadcast.'
          },
          null,
          2
        )
      );
      return;
    }

    const privateKey = await loadPolymarketKey();
    const { privateKeyToAccount } = await import('viem/accounts');
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const proxyWalletAddress = await getPolymarketProxyWalletAddress(account.address);
    process.stderr.write(
      `[polymarket] CLOB SELL ${shares} ${outcomeArg} tokens via proxy wallet ${proxyWalletAddress}\n`
    );

    let orderResult;
    if (priceArg) {
      orderResult = await createAndPostOrder({
        tokenId,
        side: 'SELL',
        size: shares,
        price: priceArg,
        orderType: 'GTC',
        privateKey,
        proxyWalletAddress
      });
    } else {
      const orderType = useFak ? 'FAK' : 'FOK';
      orderResult = await createAndPostMarketOrder({
        tokenId,
        side: 'SELL',
        amount: shares,
        orderType,
        privateKey,
        proxyWalletAddress
      });
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          conditionId,
          question: market.question,
          outcome: outcomeArg,
          shares,
          currentPrice,
          estimatedUsd: Math.round(estimatedUsd * 100) / 100,
          proxyWalletAddress,
          signerAddress: account.address,
          orderId: orderResult?.orderId || orderResult?.orderID || orderResult?.id || null,
          orderStatus: orderResult?.status || null
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error(
      JSON.stringify(
        { ok: false, error: (err as Error).message, stack: (err as Error).stack },
        null,
        2
      )
    );
    process.exit(1);
  }
}

async function handlePositions(): Promise<void> {
  try {
    const privateKey = await loadPolymarketKey();
    const { privateKeyToAccount } = await import('viem/accounts');
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const proxyWalletAddress = await getPolymarketProxyWalletAddress(account.address);

    const positions = await getPositions(proxyWalletAddress);
    console.log(
      JSON.stringify(
        {
          ok: true,
          proxyWalletAddress,
          count: Array.isArray(positions) ? positions.length : 0,
          positions
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: (err as Error).message }));
    process.exit(1);
  }
}

async function handleOrders(): Promise<void> {
  try {
    const privateKey = await loadPolymarketKey();
    const orders = await getOpenOrders(privateKey);
    console.log(
      JSON.stringify(
        {
          ok: true,
          count: Array.isArray(orders) ? orders.length : 0,
          orders
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: (err as Error).message }));
    process.exit(1);
  }
}

async function handleCancel(argv: { orderId: string }): Promise<void> {
  try {
    const privateKey = await loadPolymarketKey();
    const result = await cancelOrder(argv.orderId, privateKey);
    console.log(JSON.stringify({ ok: true, orderId: argv.orderId, result }));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: (err as Error).message }));
    process.exit(1);
  }
}

// ─── Command module ───────────────────────────────────────────────────────────

export const polymarketCommand: CommandModule = {
  command: 'polymarket',
  describe: 'Polymarket prediction market trading',
  builder: (yargs) =>
    yargs
      .command({
        command: 'markets',
        describe: 'List active markets by volume',
        builder: (y) =>
          y
            .option('search', { type: 'string', describe: 'Filter by question text' })
            .option('limit', { type: 'number', default: 20, describe: 'Number of results' })
            .option('offset', { type: 'number', default: 0, describe: 'Pagination offset' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: (argv) => handleMarkets(argv as any)
      })
      .command({
        command: 'market <conditionId>',
        describe: 'Get a single market by conditionId',
        builder: (y) =>
          y.positional('conditionId', {
            type: 'string',
            demandOption: true,
            describe: 'Market condition ID'
          }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: (argv) => handleMarket(argv as any)
      })
      .command({
        command: 'set-key <privateKey>',
        describe: 'Import EOA private key for Polymarket signing (stored encrypted)',
        builder: (y) =>
          y.positional('privateKey', {
            type: 'string',
            demandOption: true,
            describe: 'EOA private key (hex)'
          }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: (argv) => handleSetKey(argv as any)
      })
      .command({
        command: 'proxy-wallet',
        describe: 'Show Polymarket proxy wallet address for the active EOA',
        builder: (y) => y,
        handler: () => handleProxyWallet()
      })
      .command({
        command: 'approve',
        describe: 'Set proxy wallet approvals (run once before clob-buy)',
        builder: (y) =>
          y
            .option('neg-risk', {
              type: 'boolean',
              default: false,
              describe: 'Set neg-risk approvals'
            })
            .option('broadcast', {
              type: 'boolean',
              default: false,
              describe: 'Execute (dry-run without)'
            }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: (argv) => handleApprove(argv as any)
      })
      .command({
        command: 'clob-buy <conditionId> <outcome> <amount>',
        describe: 'Buy YES/NO tokens via CLOB (funds proxy wallet first)',
        builder: (y) =>
          y
            .positional('conditionId', { type: 'string', demandOption: true })
            .positional('outcome', { type: 'string', demandOption: true, describe: 'YES or NO' })
            .positional('amount', { type: 'number', demandOption: true, describe: 'USDC to spend' })
            .option('wallet', {
              type: 'string',
              default: 'main',
              describe: 'Smart wallet to fund from'
            })
            .option('price', {
              type: 'number',
              describe: 'Limit price 0-1 (GTC); omit for market order'
            })
            .option('fak', { type: 'boolean', default: false, describe: 'Use FAK instead of FOK' })
            .option('skip-fund', {
              type: 'boolean',
              default: false,
              describe: 'Skip wallet→proxy funding'
            })
            .option('broadcast', {
              type: 'boolean',
              default: false,
              describe: 'Execute (dry-run without)'
            }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: (argv) => handleClobBuy(argv as any)
      })
      .command({
        command: 'sell <conditionId> <outcome> <shares>',
        describe: 'Sell YES/NO tokens via CLOB',
        builder: (y) =>
          y
            .positional('conditionId', { type: 'string', demandOption: true })
            .positional('outcome', { type: 'string', demandOption: true, describe: 'YES or NO' })
            .positional('shares', {
              type: 'number',
              demandOption: true,
              describe: 'Number of tokens to sell'
            })
            .option('price', {
              type: 'number',
              describe: 'Limit price 0-1 (GTC); omit for market order'
            })
            .option('fak', { type: 'boolean', default: false, describe: 'Use FAK instead of FOK' })
            .option('broadcast', {
              type: 'boolean',
              default: false,
              describe: 'Execute (dry-run without)'
            }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: (argv) => handleSell(argv as any)
      })
      .command({
        command: 'positions',
        describe: 'List open positions for the Polymarket proxy wallet',
        builder: (y) => y,
        handler: () => handlePositions()
      })
      .command({
        command: 'orders',
        describe: 'List open CLOB orders for the active EOA',
        builder: (y) => y,
        handler: () => handleOrders()
      })
      .command({
        command: 'cancel <orderId>',
        describe: 'Cancel an open CLOB order',
        builder: (y) =>
          y.positional('orderId', {
            type: 'string',
            demandOption: true,
            describe: 'Order ID to cancel'
          }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: (argv) => handleCancel(argv as any)
      })
      .demandCommand(1, '')
      .showHelpOnFail(true),
  handler: () => {}
};

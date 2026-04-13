// Polymarket CLI commands
// Architecture: Sequence smart wallet → CLOB directly (EIP-1271 / POLY_GNOSIS_SAFE)
// - Smart wallet is the CLOB order maker — no separate EOA or proxy wallet required
// - `approve`: sets CTF/USDC.e approvals on the smart wallet directly
// - `clob-buy`: places CLOB BUY order signed by the smart wallet session key
// - CLOB orders: maker=smartWallet, signer=sessionKey, signatureType=POLY_GNOSIS_SAFE

import type { CommandModule } from 'yargs';

import { runDappClientTx } from '../lib/dapp-client.ts';
import {
  getMarkets,
  getMarket,
  getOpenOrders,
  cancelOrder,
  createAndPostOrder,
  createAndPostMarketOrder,
  getPositions,
  buildSequenceSignerForPolymarket,
  USDC_E,
  CTF,
  CTF_EXCHANGE,
  NEG_RISK_CTF_EXCHANGE,
  NEG_RISK_ADAPTER
} from '../lib/polymarket.ts';
import { loadWalletSession } from '../lib/storage.ts';

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

async function handleApprove(argv: {
  negRisk?: boolean;
  broadcast?: boolean;
  wallet?: string;
}): Promise<void> {
  const negRisk = argv.negRisk ?? false;
  const broadcast = argv.broadcast ?? false;
  const walletName = argv.wallet ?? 'main';

  try {
    const session = await loadWalletSession(walletName);
    if (!session) throw new Error(`Wallet not found: ${walletName}`);
    const smartWalletAddress = session.walletAddress;

    const MAX_UINT256 = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    const pad = (val: string, n = 64) => val.replace(/^0x/, '').padStart(n, '0');
    const erc20ApproveData = (spender: string) => '0x095ea7b3' + pad(spender) + pad(MAX_UINT256);
    const erc1155ApproveAllData = (operator: string) => '0xa22cb465' + pad(operator) + pad('0x01');

    let txBatch;
    let approvalLabels: string[];
    if (negRisk) {
      txBatch = [
        { to: USDC_E, value: 0n, data: erc20ApproveData(NEG_RISK_ADAPTER) },
        { to: USDC_E, value: 0n, data: erc20ApproveData(NEG_RISK_CTF_EXCHANGE) },
        { to: CTF, value: 0n, data: erc1155ApproveAllData(CTF_EXCHANGE) },
        { to: CTF, value: 0n, data: erc1155ApproveAllData(NEG_RISK_CTF_EXCHANGE) },
        { to: CTF, value: 0n, data: erc1155ApproveAllData(NEG_RISK_ADAPTER) }
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
        { to: USDC_E, value: 0n, data: erc20ApproveData(CTF_EXCHANGE) },
        { to: CTF, value: 0n, data: erc1155ApproveAllData(CTF_EXCHANGE) }
      ];
      approvalLabels = ['USDC.e → CTF_EXCHANGE', 'CTF → CTF_EXCHANGE'];
    }

    if (!broadcast) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            dryRun: true,
            smartWalletAddress,
            negRisk,
            approvals: approvalLabels,
            note: 'Re-run with --broadcast to execute. Smart wallet must hold USDC.e for gas fees.'
          },
          null,
          2
        )
      );
      return;
    }

    process.stderr.write(
      `[polymarket] Setting ${txBatch.length} approvals on smart wallet ${smartWalletAddress}...\n`
    );

    const result = await runDappClientTx({
      walletName,
      chainId: 137,
      transactions: txBatch,
      broadcast: true,
      preferNativeFee: false
    });

    process.stderr.write(`[polymarket] Approvals set: ${result.txHash}\n`);

    console.log(
      JSON.stringify(
        {
          ok: true,
          smartWalletAddress,
          negRisk,
          approveTxHash: result.txHash,
          note: 'Smart wallet approvals set. Ready for clob-buy and sell.'
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
  broadcast?: boolean;
}): Promise<void> {
  const conditionId = argv.conditionId;
  const outcomeArg = argv.outcome.toUpperCase();
  const amountUsd = argv.amount;
  const walletName = argv.wallet ?? 'main';
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
    const orderType = priceArg ? 'GTC' : useFak ? 'FAK' : 'FOK';

    if (!broadcast) {
      let smartWalletAddress: string | null = null;
      try {
        const session = await loadWalletSession(walletName);
        smartWalletAddress = session?.walletAddress ?? null;
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
            smartWalletAddress,
            flow: [
              'Place CLOB BUY order (maker=smartWallet, signatureType=POLY_GNOSIS_SAFE)',
              'USDC.e debited directly from smart wallet — no fund transfer needed'
            ],
            note: 'Requires smart wallet approvals — run `polymarket approve --broadcast` once first. Re-run with --broadcast to execute.'
          },
          null,
          2
        )
      );
      return;
    }

    const { walletClient, smartWalletAddress } = await buildSequenceSignerForPolymarket(walletName);

    process.stderr.write(
      `[polymarket] CLOB BUY ${amountUsd} USDC → ${outcomeArg} via smart wallet ${smartWalletAddress}\n`
    );

    let orderResult;
    if (priceArg) {
      const estimatedShares = amountUsd / priceArg;
      orderResult = await createAndPostOrder({
        tokenId,
        side: 'BUY',
        size: estimatedShares,
        price: priceArg,
        orderType: 'GTC',
        walletClient,
        smartWalletAddress
      });
    } else {
      orderResult = await createAndPostMarketOrder({
        tokenId,
        side: 'BUY',
        amount: amountUsd,
        orderType,
        walletClient,
        smartWalletAddress
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
          smartWalletAddress,
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
  wallet?: string;
  price?: number;
  fak?: boolean;
  broadcast?: boolean;
}): Promise<void> {
  const conditionId = argv.conditionId;
  const outcomeArg = argv.outcome.toUpperCase();
  const shares = argv.shares;
  const walletName = argv.wallet ?? 'main';
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
      let smartWalletAddress: string | null = null;
      try {
        const session = await loadWalletSession(walletName);
        smartWalletAddress = session?.walletAddress ?? null;
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
            smartWalletAddress,
            note: 'Tokens must be in the smart wallet. Re-run with --broadcast to execute.'
          },
          null,
          2
        )
      );
      return;
    }

    const { walletClient, smartWalletAddress } = await buildSequenceSignerForPolymarket(walletName);

    process.stderr.write(
      `[polymarket] CLOB SELL ${shares} ${outcomeArg} tokens via smart wallet ${smartWalletAddress}\n`
    );

    let orderResult;
    if (priceArg) {
      orderResult = await createAndPostOrder({
        tokenId,
        side: 'SELL',
        size: shares,
        price: priceArg,
        orderType: 'GTC',
        walletClient,
        smartWalletAddress
      });
    } else {
      const orderType = useFak ? 'FAK' : 'FOK';
      orderResult = await createAndPostMarketOrder({
        tokenId,
        side: 'SELL',
        amount: shares,
        orderType,
        walletClient,
        smartWalletAddress
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
          smartWalletAddress,
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

async function handlePositions(argv: { wallet?: string }): Promise<void> {
  const walletName = argv.wallet ?? 'main';
  try {
    const session = await loadWalletSession(walletName);
    if (!session) throw new Error(`Wallet not found: ${walletName}`);
    const smartWalletAddress = session.walletAddress;

    const positions = await getPositions(smartWalletAddress);
    console.log(
      JSON.stringify(
        {
          ok: true,
          smartWalletAddress,
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

async function handleOrders(argv: { wallet?: string }): Promise<void> {
  const walletName = argv.wallet ?? 'main';
  try {
    const { walletClient, smartWalletAddress } = await buildSequenceSignerForPolymarket(walletName);
    const orders = await getOpenOrders(walletClient, smartWalletAddress);
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

async function handleCancel(argv: { orderId: string; wallet?: string }): Promise<void> {
  const walletName = argv.wallet ?? 'main';
  try {
    const { walletClient, smartWalletAddress } = await buildSequenceSignerForPolymarket(walletName);
    const result = await cancelOrder(argv.orderId, walletClient, smartWalletAddress);
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
        command: 'approve',
        describe: 'Set smart wallet approvals for Polymarket (run once before clob-buy)',
        builder: (y) =>
          y
            .option('neg-risk', {
              type: 'boolean',
              default: false,
              describe: 'Set neg-risk market approvals'
            })
            .option('wallet', {
              type: 'string',
              default: 'main',
              describe: 'Wallet name'
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
        describe: 'Buy YES/NO tokens via CLOB using smart wallet',
        builder: (y) =>
          y
            .positional('conditionId', { type: 'string', demandOption: true })
            .positional('outcome', { type: 'string', demandOption: true, describe: 'YES or NO' })
            .positional('amount', { type: 'number', demandOption: true, describe: 'USDC to spend' })
            .option('wallet', {
              type: 'string',
              default: 'main',
              describe: 'Wallet name'
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
            .option('wallet', {
              type: 'string',
              default: 'main',
              describe: 'Wallet name'
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
        describe: 'List open positions for the smart wallet',
        builder: (y) =>
          y.option('wallet', { type: 'string', default: 'main', describe: 'Wallet name' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: (argv) => handlePositions(argv as any)
      })
      .command({
        command: 'orders',
        describe: 'List open CLOB orders for the smart wallet',
        builder: (y) =>
          y.option('wallet', { type: 'string', default: 'main', describe: 'Wallet name' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: (argv) => handleOrders(argv as any)
      })
      .command({
        command: 'cancel <orderId>',
        describe: 'Cancel an open CLOB order',
        builder: (y) =>
          y
            .positional('orderId', {
              type: 'string',
              demandOption: true,
              describe: 'Order ID to cancel'
            })
            .option('wallet', { type: 'string', default: 'main', describe: 'Wallet name' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: (argv) => handleCancel(argv as any)
      })
      .demandCommand(1, '')
      .showHelpOnFail(true),
  handler: () => {}
};

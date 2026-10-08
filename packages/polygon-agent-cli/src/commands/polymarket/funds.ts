// deposit / withdraw: move money between the OMS wallet and the Polymarket
// Deposit Wallet through Polymarket's bridge. The OMS side is a plain USDC
// transfer, so session-mode allowances cover deposits.

import type { CommandModule } from 'yargs';

import { encodeFunctionData, erc20Abi } from 'viem';

import { CliError } from '../../lib/errors.ts';
import { resolveBroadcast, withWriteFlags } from '../../lib/mode.ts';
import { getTradingClient, pusdBalance, requireAccount } from '../../lib/polymarket/account.ts';
import { formatUnits6, parseUsd } from '../../lib/polymarket/amounts.ts';
import {
  BRIDGE_MIN_DEPOSIT_UNITS,
  bridgeStatus,
  depositAddress,
  withdrawAddress
} from '../../lib/polymarket/bridge.ts';
import { clearPending, loadPending, savePending } from '../../lib/polymarket/deposits.ts';
import { PolymarketError, PUSD } from '../../lib/polymarket/gamma.ts';
import { assertCanTrade, checkRegion } from '../../lib/polymarket/region.ts';
import { tokenBalance } from '../../lib/session/live.ts';
import { checkSessionSpend } from '../../lib/session/run-tx.ts';
import { loadOmsWalletPointer } from '../../lib/storage.ts';
import { runTx } from '../../lib/tx-dispatch.ts';
import { fail, ok, omsAddress, walletOption } from './shared.ts';

const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const POLL_MS = 5_000;
const WAIT_MS = 5 * 60_000;

type DepositArgs = {
  amount: string;
  wallet: string;
  again?: boolean;
  wait?: boolean;
  broadcast?: boolean;
  dryRun?: boolean;
};

// An earlier deposit is on record: settle it (credited, failed) or refuse to send again.
async function settlePending(wallet: string): Promise<void> {
  const pending = loadPending(wallet);
  if (!pending) return;
  const { transactions } = await bridgeStatus(pending.bridgeAddress);
  if (transactions.some((t) => t.status === 'COMPLETED')) {
    clearPending(wallet);
    return;
  }
  if (transactions.some((t) => t.status === 'FAILED')) {
    clearPending(wallet);
    throw new CliError({
      code: 'upstream_error',
      message: `The earlier deposit of $${formatUnits6(BigInt(pending.amountUnits))} failed at Polymarket's bridge.`,
      hint: 'Check https://recovery.polymarket.com, then deposit again.',
      details: { txHash: pending.txHash, bridgeStatus: 'FAILED' }
    });
  }
  throw new CliError({
    code: 'bridge_pending',
    message: `An earlier deposit of $${formatUnits6(BigInt(pending.amountUnits))} is still being credited.`,
    hint: 'Check agent polymarket status, or pass --again to send another deposit anyway.',
    details: { txHash: pending.txHash, sentAt: pending.sentAt }
  });
}

async function handleDeposit(argv: DepositArgs): Promise<void> {
  try {
    const units = parseUsd(argv.amount);
    if (units < BRIDGE_MIN_DEPOSIT_UNITS) {
      throw new PolymarketError(
        'below_bridge_minimum',
        `Polymarket's bridge needs at least $${formatUnits6(BRIDGE_MIN_DEPOSIT_UNITS)} per deposit.`
      );
    }
    const broadcast = resolveBroadcast(argv);
    const account = requireAccount(argv.wallet);
    assertCanTrade(await checkRegion());

    if (!argv.again) await settlePending(argv.wallet);

    const from = await omsAddress(argv.wallet);
    const held = await tokenBalance({
      wallet: argv.wallet,
      chainId: 137,
      token: USDC,
      walletAddress: from
    });
    if (held < units) {
      throw new CliError({
        code: 'insufficient_balance',
        message: `Wallet '${argv.wallet}' holds $${formatUnits6(held)} USDC on Polygon; the deposit needs $${formatUnits6(units)}.`,
        hint: `agent swap --to USDC --amount ${formatUnits6(units - held)} --broadcast`
      });
    }

    const bridge = await depositAddress(account.wallet);

    if (!broadcast) {
      // One JSON document: runTx would print its own dry-run output, so don't call it.
      const summary: Record<string, unknown> = {
        dryRun: true,
        from,
        bridgeAddress: bridge,
        polymarketWallet: account.wallet,
        amountUsd: formatUnits6(units)
      };
      const pointer = await loadOmsWalletPointer(argv.wallet);
      if (pointer?.access === 'session') {
        const check = await checkSessionSpend({
          walletName: argv.wallet,
          walletAddress: from,
          chainId: 137,
          token: USDC,
          amount: units
        });
        summary.allowance = {
          usd: check.usd,
          allowanceUsd: check.allowanceUsd,
          spentUsd: check.spentUsd
        };
      }
      ok(summary);
      return;
    }

    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [bridge as `0x${string}`, units]
    });
    const before = await pusdBalance(argv.wallet);
    const res = await runTx({
      walletName: argv.wallet,
      chainId: 137,
      transactions: [{ to: USDC, value: 0n, data }],
      broadcast,
      purpose: 'trade',
      ref: 'polymarket-deposit'
    });
    const txHash = res.txHash ?? '';
    savePending(argv.wallet, {
      txHash,
      amountUnits: units.toString(),
      bridgeAddress: bridge,
      sentAt: new Date().toISOString()
    });
    if (argv.wait === false) {
      ok({ txHash, credited: false, amountUsd: formatUnits6(units) });
      return;
    }
    const target = before + (units * 99n) / 100n;
    const deadline = Date.now() + WAIT_MS;
    let balance = before;
    while (Date.now() < deadline) {
      balance = await pusdBalance(argv.wallet);
      if (balance >= target) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    if (balance >= target) {
      clearPending(argv.wallet);
      ok({
        txHash,
        credited: true,
        amountUsd: formatUnits6(units),
        pusdBalance: formatUnits6(balance)
      });
    } else {
      ok({
        txHash,
        credited: false,
        amountUsd: formatUnits6(units),
        hint: 'The bridge is still crediting; run agent polymarket status in a few minutes.'
      });
    }
  } catch (err) {
    fail(err, { stack: true });
  }
}

type WithdrawArgs = { amount: string; wallet: string; broadcast?: boolean; dryRun?: boolean };

async function handleWithdraw(argv: WithdrawArgs): Promise<void> {
  try {
    const broadcast = resolveBroadcast(argv);
    const account = requireAccount(argv.wallet);
    assertCanTrade(await checkRegion());
    const balance = await pusdBalance(argv.wallet);
    const amount = String(argv.amount).toLowerCase() === 'all' ? balance : parseUsd(argv.amount);
    if (amount === 0n || amount > balance) {
      throw new PolymarketError(
        'insufficient_pusd',
        `The Polymarket wallet holds $${formatUnits6(balance)} pUSD.`
      );
    }
    const recipient = await omsAddress(argv.wallet);
    const bridge = await withdrawAddress({ wallet: account.wallet, recipient });
    if (!broadcast) {
      ok({
        dryRun: true,
        amountUsd: formatUnits6(amount),
        from: account.wallet,
        to: recipient,
        via: bridge
      });
      return;
    }
    const client = await getTradingClient(argv.wallet);
    const handle = await client.transferErc20({
      amount,
      recipientAddress: bridge,
      tokenAddress: PUSD
    });
    const outcome = await handle.wait();
    ok({ txHash: outcome.transactionHash, amountUsd: formatUnits6(amount), to: recipient });
  } catch (err) {
    fail(err, { stack: true });
  }
}

export const depositCommand: CommandModule = {
  command: 'deposit <amount>',
  describe: 'Move USDC from the OMS wallet into the Polymarket account (min $2)',
  builder: (y) =>
    withWriteFlags(
      walletOption(y)
        .positional('amount', { type: 'string', demandOption: true, describe: 'USD amount' })
        .option('again', {
          type: 'boolean',
          default: false,
          describe: 'Send even if an earlier deposit is still pending'
        })
        .option('wait', {
          type: 'boolean',
          default: true,
          describe: 'Wait for the bridge to credit pUSD (--no-wait to skip)'
        })
    ),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleDeposit(argv as any)
};

export const withdrawCommand: CommandModule = {
  command: 'withdraw <amount>',
  describe: 'Move pUSD from the Polymarket account back to the OMS wallet as USDC',
  builder: (y) =>
    withWriteFlags(
      walletOption(y).positional('amount', {
        type: 'string',
        demandOption: true,
        describe: "USD amount or 'all'"
      })
    ),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleWithdraw(argv as any)
};

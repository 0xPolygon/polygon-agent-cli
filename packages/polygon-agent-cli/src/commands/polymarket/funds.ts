// deposit / withdraw: move money between the OMS wallet and the Polymarket
// Deposit Wallet through Polymarket's bridge. The OMS side is a plain USDC
// transfer, so session-mode allowances cover deposits.

import type { CommandModule } from 'yargs';

import path from 'node:path';

import { encodeFunctionData, erc20Abi } from 'viem';

import type { PendingDeposit } from '../../lib/polymarket/deposits.ts';

import { CliError, NOTHING_SENT_CODES } from '../../lib/errors.ts';
import { LockHeldError, withLock } from '../../lib/lock.ts';
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
import { loadOmsWalletPointer, STORAGE_ROOT } from '../../lib/storage.ts';
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
// Read-only when `readOnly` (dry runs never change state).
async function settlePending(wallet: string, readOnly: boolean): Promise<void> {
  const pending = loadPending(wallet);
  if (!pending) return;
  const { transactions } = await bridgeStatus(pending.bridgeAddress);
  // The address is static, so the list holds every deposit ever made to it, newest
  // first. Only the entries beyond the baseline can belong to this deposit.
  const fresh = transactions.slice(
    0,
    Math.max(0, transactions.length - (pending.baselineCount ?? transactions.length))
  );
  let settled = fresh.some((t) => t.status === 'COMPLETED');
  if (!settled) {
    const now = await pusdBalance(wallet);
    settled =
      pending.pusdBefore !== undefined &&
      now >= BigInt(pending.pusdBefore) + (BigInt(pending.amountUnits) * 99n) / 100n;
  }
  if (settled) {
    if (!readOnly) clearPending(wallet);
    return;
  }
  const amount = formatUnits6(pending.amountUnits);
  if (fresh.some((t) => t.status === 'FAILED')) {
    if (!readOnly) clearPending(wallet);
    throw new CliError({
      code: 'upstream_error',
      message: `The earlier deposit of $${amount} failed at Polymarket's bridge.`,
      hint: 'Check https://recovery.polymarket.com, then deposit again.',
      details: { txHash: pending.txHash, bridgeStatus: 'FAILED' }
    });
  }
  throw new CliError({
    code: 'bridge_pending',
    message: `An earlier deposit of $${amount} is still being credited.`,
    hint: 'Check agent polymarket status, or pass --again to send another deposit anyway.',
    details: { txHash: pending.txHash, sentAt: pending.sentAt }
  });
}

// Not the session wallet lock: runTx takes that one itself in session mode, so
// reusing it here would deadlock.
async function withDepositLock<T>(wallet: string, fn: () => Promise<T>): Promise<T> {
  const dir = path.join(STORAGE_ROOT, 'locks', 'polymarket', wallet);
  try {
    return await withLock({ dir, fn });
  } catch (err) {
    if (err instanceof LockHeldError && err.dir === dir) {
      throw new CliError({
        code: 'wallet_busy',
        message: `Another Polymarket deposit for wallet '${wallet}' is still running. Try again when it finishes.`,
        hint: 'Then check agent polymarket status before depositing again.',
        cause: err
      });
    }
    throw err;
  }
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

    // From the pending check to the saved 'sent' record, one deposit per wallet at a
    // time: two concurrent runs could both pass the check and both send.
    const sendSection = async (): Promise<{ txHash: string | null; before: bigint } | null> => {
      if (!argv.again) await settlePending(argv.wallet, !broadcast);

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
        return null;
      }

      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [bridge as `0x${string}`, units]
      });
      const before = await pusdBalance(argv.wallet);
      const baselineCount = (await bridgeStatus(bridge)).transactions.length;
      const record: PendingDeposit = {
        status: 'sending',
        txHash: null,
        amountUnits: units.toString(),
        bridgeAddress: bridge,
        sentAt: new Date().toISOString(),
        baselineCount,
        pusdBefore: before.toString()
      };
      // Recorded before sending: if the run dies after the transfer is relayed, a rerun
      // must not send again.
      savePending(argv.wallet, record);
      let res;
      try {
        res = await runTx({
          walletName: argv.wallet,
          chainId: 137,
          transactions: [{ to: USDC, value: 0n, data }],
          broadcast,
          purpose: 'trade',
          ref: 'polymarket-deposit'
        });
      } catch (err) {
        if (err instanceof CliError && NOTHING_SENT_CODES.has(err.code)) clearPending(argv.wallet);
        throw err;
      }
      const txHash = res.txHash ?? null;
      savePending(argv.wallet, { ...record, status: 'sent', txHash });
      return { txHash, before };
    };

    // Dry runs change nothing, so they don't take the lock.
    const sent = broadcast ? await withDepositLock(argv.wallet, sendSection) : await sendSection();
    if (!sent) return;
    const { txHash, before } = sent;
    if (argv.wait === false) {
      ok({ txHash, credited: false, amountUsd: formatUnits6(units) });
      return;
    }
    const target = before + (units * 99n) / 100n;
    const deadline = Date.now() + WAIT_MS;
    let balance = before;
    while (Date.now() < deadline) {
      try {
        balance = await pusdBalance(argv.wallet);
      } catch {
        // Money has moved: a failed read means "not yet credited", not a failed deposit.
      }
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
    ok({
      txHash: outcome.transactionHash,
      amountUsd: formatUnits6(amount),
      to: recipient,
      note: "txHash is the pUSD transfer to Polymarket's bridge. The USDC arrives in the OMS wallet shortly after."
    });
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

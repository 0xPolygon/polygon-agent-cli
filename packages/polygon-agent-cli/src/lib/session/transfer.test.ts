import type { Address } from 'viem';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { decodeFunctionData, erc20Abi, getAddress } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RemoteAccessSession, TransactionStatus } from '@polygonlabs/oms-wallet';

import { OMSWalletRequestError } from '@polygonlabs/oms-wallet';

import type { TransferDeps, RacClient } from './transfer.ts';

// The state folder must be set before the session modules load (they read it
// at import), so they're imported dynamically below.
process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-transfer-'));

const { CliError } = await import('../errors.ts');
const { readLedger, appendLedger } = await import('./ledger.ts');
const { buildPlan } = await import('./plan.ts');
const { sessionDir, writeApprovedPlan } = await import('./state.ts');
const { listTransfers, probeSponsorship, sessionTransfer } = await import('./transfer.ts');
const { supportedTokens } = await import('./tokens.ts');

const USDC = getAddress('0x3c499c542cef5e3811e1192ce70d8cc03d5c3359');
const WETH = getAddress('0x7ceb23fd6bc0add59e62ac25578270cff1b9f619');
const WALLET_ADDRESS = getAddress('0xd384ea24ca0B3a5e4BB35935C611E3dCB68Fd08e');
const TO = getAddress('0x1D17C0F90A0b3dFb5124C2FF56B33a0D2E202e1d');
const START = new Date('2026-10-06T00:00:00Z');

let walletCounter = 0;

interface Fake {
  wallet: string;
  client: RacClient;
  deps: TransferDeps;
  calls: { prepare: number; execute: number; status: number };
  state: {
    used: bigint;
    limit: bigint;
    sponsored: boolean;
    expiresAt: string;
    statuses: Array<{ status: TransactionStatus; txnHash?: string }>;
    executeError?: unknown;
    prepareError?: unknown;
    balance: bigint;
  };
  recordAtExecute?: string;
}

function setup(overrides: Partial<Fake['state']> = {}): Fake {
  const wallet = `w${++walletCounter}`;
  const tokens = supportedTokens(137).map((t) => ({ chainId: 137, ...t }));
  const plan = buildPlan({
    allowanceUsd: 100,
    days: 30,
    tokens,
    prices: new Map(
      tokens.filter((t) => t.kind !== 'usd').map((t) => [`137:${t.address.toLowerCase()}`, 2500])
    ),
    now: START
  });
  plan.chains[0].sessionId = 'sess-1';
  writeApprovedPlan({ wallet, approved: { plan, approvedAt: START.toISOString() } });

  let clock = START.getTime();
  const fake: Fake = {
    wallet,
    calls: { prepare: 0, execute: 0, status: 0 },
    state: {
      used: 0n,
      limit: 100_000_000n,
      sponsored: true,
      expiresAt: '2026-11-05T00:00:00Z',
      statuses: [{ status: 'executed', txnHash: '0xhash' }],
      balance: 1_000_000_000n,
      ...overrides
    },
    client: undefined as never,
    deps: undefined as never
  };
  const session = (): RemoteAccessSession => ({
    sessionId: 'sess-1',
    walletId: 'wal-1',
    signerAddress: TO,
    chainId: 137,
    expiresAt: fake.state.expiresAt,
    grants: [
      { kind: 'erc20Transfer', token: USDC, limit: fake.state.limit, cumulative: true },
      { kind: 'erc20Transfer', token: WETH, limit: 10n ** 18n, cumulative: true }
    ]
  });
  fake.client = {
    listSessions: async () => [session()],
    getSessionUsage: async () => [
      { grant: session().grants[0], used: fake.state.used },
      { grant: session().grants[1], used: 0n }
    ],
    prepareTransaction: async () => {
      fake.calls.prepare++;
      if (fake.state.prepareError) throw fake.state.prepareError;
      return {
        txnId: `txn-${fake.calls.prepare}`,
        status: 'quoted',
        feeOptions: [],
        sponsored: fake.state.sponsored,
        expiresAt: ''
      };
    },
    executeTransaction: async () => {
      fake.calls.execute++;
      fake.recordAtExecute = JSON.stringify(listTransfers(wallet).at(-1));
      if (fake.state.executeError) throw fake.state.executeError;
      return { status: 'pending' };
    },
    getTransactionStatus: async () => {
      fake.calls.status++;
      return fake.state.statuses.length > 1
        ? (fake.state.statuses.shift() ?? { status: 'unknown' })
        : fake.state.statuses[0];
    }
  };
  fake.deps = {
    credentialId: 'cred-1',
    client: fake.client,
    balanceOf: async () => fake.state.balance,
    usdPrice: async () => 2500,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock)
  };
  return fake;
}

function send(fake: Fake, amount: bigint, token: Address = USDC) {
  return sessionTransfer({
    wallet: fake.wallet,
    walletAddress: WALLET_ADDRESS,
    chainId: 137,
    token,
    to: TO,
    amount,
    purpose: 'send',
    deps: fake.deps
  });
}

const httpError = (status: number, name?: string) =>
  new OMSWalletRequestError({
    code: 'OMS_HTTP_ERROR',
    message: name ?? `HTTP ${status}`,
    status,
    upstreamError: { service: 'waas', status, ...(name ? { name } : {}) }
  });

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('sessionTransfer', () => {
  it('prepares, saves the txnId before executing, and records the spend', async () => {
    const fake = setup();
    const result = await send(fake, 1_500_000n);
    expect(result).toMatchObject({ txHash: '0xhash', txnId: 'txn-1', usd: 1.5 });
    expect(fake.calls).toMatchObject({ prepare: 1, execute: 1 });
    expect(JSON.parse(fake.recordAtExecute ?? '{}')).toMatchObject({
      state: 'prepared',
      txnId: 'txn-1'
    });
    expect(listTransfers(fake.wallet).at(-1)).toMatchObject({
      state: 'executed',
      txHash: '0xhash',
      ledgered: true
    });
    expect(readLedger(fake.wallet)).toEqual([
      expect.objectContaining({
        chainId: 137,
        symbol: 'USDC',
        amount: '1500000',
        usd: 1.5,
        purpose: 'send',
        ref: '0xhash'
      })
    ]);
  });

  it('sends exactly transfer(to, amount) to the token contract', async () => {
    const fake = setup();
    const prepare = vi.spyOn(fake.client, 'prepareTransaction');
    await send(fake, 1n);
    const call = prepare.mock.calls[0][0];
    expect(call).toMatchObject({ walletId: 'wal-1', sessionId: 'sess-1', to: USDC });
    expect(decodeFunctionData({ abi: erc20Abi, data: call.data ?? '0x' })).toEqual({
      functionName: 'transfer',
      args: [TO, 1n]
    });
  });

  it('refuses an unsponsored transfer without executing it', async () => {
    const fake = setup({ sponsored: false });
    await expect(send(fake, 1n)).rejects.toMatchObject({ code: 'not_sponsored' });
    expect(fake.calls.execute).toBe(0);
    expect(listTransfers(fake.wallet).at(-1)).toMatchObject({ state: 'failed' });
  });

  it('a 4xx execute rejection fails without resending', async () => {
    const fake = setup({ executeError: httpError(400, 'UsageLimitExceeded') });
    await expect(send(fake, 1n)).rejects.toMatchObject({ code: 'allowance_exhausted' });
    expect(fake.calls).toMatchObject({ prepare: 1, execute: 1, status: 0 });
    expect(readLedger(fake.wallet)).toEqual([]);
  });

  it('a network error on execute is settled by polling, not by resending', async () => {
    const fake = setup({
      executeError: new TypeError('fetch failed'),
      statuses: [
        { status: 'pending' },
        { status: 'pending' },
        { status: 'executed', txnHash: '0xlater' }
      ]
    });
    expect(await send(fake, 1n)).toMatchObject({ txHash: '0xlater' });
    expect(fake.calls).toMatchObject({ prepare: 1, execute: 1 });
  });

  it('an unsettled transfer blocks new ones until OMS settles it, and is never resent', async () => {
    const fake = setup({
      executeError: new TypeError('timeout'),
      statuses: [{ status: 'pending' }]
    });
    await expect(send(fake, 1n)).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(listTransfers(fake.wallet).at(-1)).toMatchObject({ state: 'uncertain', txnId: 'txn-1' });

    // Still unknown: the next transfer doesn't start.
    await expect(send(fake, 2n)).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(fake.calls.prepare).toBe(1);

    // OMS settles it: it's recorded once, then the new transfer goes ahead.
    fake.state.executeError = undefined;
    fake.state.statuses = [{ status: 'executed', txnHash: '0xfirst' }];
    expect(await send(fake, 2n)).toMatchObject({ txnId: 'txn-2' });
    // One execute per transfer: the uncertain one was never executed again.
    expect(fake.calls).toMatchObject({ prepare: 2, execute: 2 });
    expect(readLedger(fake.wallet).map((e) => e.amount)).toEqual(['1', '2']);
  });

  it('a transfer prepared but never executed (crash) is closed out, not executed', async () => {
    const fake = setup({ statuses: [{ status: 'quoted' }] });
    const dir = path.join(sessionDir(fake.wallet), 'transfers');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'old.json'),
      JSON.stringify({
        id: 'old',
        state: 'prepared',
        chainId: 137,
        token: USDC,
        symbol: 'USDC',
        to: TO,
        amount: '5',
        usd: 0,
        purpose: 'send',
        walletId: 'wal-1',
        sessionId: 'sess-1',
        txnId: 'txn-old',
        ledgered: false,
        createdAt: '2026-10-05T00:00:00Z',
        updatedAt: '2026-10-05T00:00:00Z'
      })
    );
    fake.state.statuses = [{ status: 'quoted' }, { status: 'executed', txnHash: '0xnew' }];
    await send(fake, 1n);
    expect(listTransfers(fake.wallet).find((r) => r.id === 'old')).toMatchObject({
      state: 'failed'
    });
    expect(fake.calls.execute).toBe(1);
  });
});

function writeRecord(fake: Fake, record: Record<string, unknown>) {
  const dir = path.join(sessionDir(fake.wallet), 'transfers');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${String(record.id)}.json`),
    JSON.stringify({
      state: 'uncertain',
      chainId: 137,
      token: USDC,
      symbol: 'USDC',
      to: TO,
      amount: '5',
      usd: 0,
      purpose: 'send',
      walletId: 'wal-1',
      sessionId: 'sess-1',
      txnId: 'txn-old',
      ledgered: false,
      createdAt: START.toISOString(),
      updatedAt: START.toISOString(),
      ...record
    })
  );
}

describe('reconciling earlier transfers', () => {
  it('abandons, rather than blocks on, a transfer left by a replaced session key', async () => {
    const fake = setup();
    writeRecord(fake, { id: 'old', credentialId: 'cred-previous' });
    await send(fake, 1n);
    expect(listTransfers(fake.wallet).find((r) => r.id === 'old')).toMatchObject({
      state: 'abandoned'
    });
  });

  it('treats a transaction OMS has no record of (404) as never run', async () => {
    const fake = setup();
    writeRecord(fake, { id: 'gone', credentialId: 'cred-1' });
    const status = fake.client.getTransactionStatus;
    let first = true;
    fake.client.getTransactionStatus = async (params) => {
      if (first) {
        first = false;
        throw httpError(404, 'TransactionNotFound');
      }
      return status(params);
    };
    await send(fake, 1n);
    expect(listTransfers(fake.wallet).find((r) => r.id === 'gone')).toMatchObject({
      state: 'failed'
    });
  });

  it('a 404 after execute was called is not proof nothing ran: it stays open', async () => {
    const fake = setup();
    writeRecord(fake, { id: 'odd', credentialId: 'cred-1', executeAttempted: true });
    fake.client.getTransactionStatus = async () => {
      throw httpError(404, 'TransactionNotFound');
    };
    await expect(send(fake, 1n)).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(listTransfers(fake.wallet).find((r) => r.id === 'odd')).toMatchObject({
      state: 'uncertain'
    });
    expect(fake.calls.prepare).toBe(0);
  });

  it('marks a 404 before any execute as certainly never sent', async () => {
    const fake = setup();
    writeRecord(fake, { id: 'gone2', credentialId: 'cred-1', state: 'prepared' });
    const status = fake.client.getTransactionStatus;
    let first = true;
    fake.client.getTransactionStatus = async (params) => {
      if (first) {
        first = false;
        throw httpError(404, 'TransactionNotFound');
      }
      return status(params);
    };
    await send(fake, 1n);
    expect(listTransfers(fake.wallet).find((r) => r.id === 'gone2')).toMatchObject({
      state: 'failed',
      neverSent: true
    });
  });

  it('does not send past notAfter (e.g. a quote that expired while waiting)', async () => {
    const fake = setup();
    await expect(
      sessionTransfer({
        wallet: fake.wallet,
        walletAddress: WALLET_ADDRESS,
        chainId: 137,
        token: USDC,
        to: TO,
        amount: 1n,
        purpose: 'trade',
        notAfter: START.getTime() - 1,
        deps: fake.deps
      })
    ).rejects.toMatchObject({ code: 'quote_expired' });
    expect(fake.calls.prepare).toBe(0);
  });

  it('keeps an uncertain transfer whose quote is still live, and closes it once expired', async () => {
    const fake = setup({ statuses: [{ status: 'quoted' }] });
    writeRecord(fake, {
      id: 'live',
      credentialId: 'cred-1',
      quoteExpiresAt: new Date(START.getTime() + 10 * 60_000).toISOString()
    });
    // The quote outlives the minute of polling: still unknown, nothing new starts.
    await expect(send(fake, 1n)).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(fake.calls.prepare).toBe(0);

    // Past the quote's expiry plus the 2-minute clock margin: never executed.
    await fake.deps.sleep(12 * 60_000);
    fake.state.statuses = [{ status: 'quoted' }, { status: 'executed', txnHash: '0xnew' }];
    await send(fake, 1n);
    expect(listTransfers(fake.wallet).find((r) => r.id === 'live')).toMatchObject({
      state: 'failed'
    });
  });
});

describe('USD accounting survives a failed ledger write', () => {
  const failAppends = (times: number) => {
    const original = fs.appendFileSync;
    let left = times;
    return vi.spyOn(fs, 'appendFileSync').mockImplementation((...args) => {
      if (left-- > 0) throw new Error('ENOSPC: no space left on device');
      return original(...args);
    });
  };

  it('a transfer whose ledger write failed still counts, and is written once later', async () => {
    const fake = setup();
    failAppends(1);
    expect(await send(fake, 60_000_000n)).toMatchObject({ usd: 60 });
    expect(readLedger(fake.wallet)).toEqual([]);
    expect(listTransfers(fake.wallet).at(-1)).toMatchObject({
      state: 'executed',
      ledgered: false
    });

    // $60 of WETH would take the total to $120 of the $100 allowance.
    await expect(send(fake, 24n * 10n ** 15n, WETH)).rejects.toMatchObject({
      code: 'allowance_exhausted'
    });
    expect(fake.calls.prepare).toBe(1);
    expect(readLedger(fake.wallet)).toEqual([
      expect.objectContaining({ usd: 60, transferId: listTransfers(fake.wallet)[0].id })
    ]);
    expect(listTransfers(fake.wallet)[0].ledgered).toBe(true);
  });

  it('while the ledger stays unwritable, no new transfer starts', async () => {
    const fake = setup();
    failAppends(Infinity);
    await send(fake, 60_000_000n);
    await expect(send(fake, 1_000_000n)).rejects.toThrow(/ENOSPC/);
    expect(fake.calls.prepare).toBe(1);
  });

  it('an append that wrote part of a line still counts, and the next entry is not lost', async () => {
    const fake = setup();
    const original = fs.appendFileSync;
    let failed = false;
    vi.spyOn(fs, 'appendFileSync').mockImplementation((file, data, options) => {
      if (!failed && String(data).length > 2) {
        failed = true;
        original(file, String(data).slice(0, 25), options);
        throw new Error('ENOSPC: no space left on device');
      }
      return original(file, data, options);
    });
    await send(fake, 60_000_000n);
    // $60 of WETH would pass the $100 allowance.
    await expect(send(fake, 24n * 10n ** 15n, WETH)).rejects.toMatchObject({
      code: 'allowance_exhausted'
    });
    expect(readLedger(fake.wallet)).toEqual([expect.objectContaining({ usd: 60 })]);
    const text = fs.readFileSync(path.join(sessionDir(fake.wallet), 'ledger.jsonl'), 'utf8');
    expect(text.trim().split('\n')).toHaveLength(1);
  });

  it('a complete entry missing only its newline is kept, not cut off', async () => {
    const fake = setup();
    await send(fake, 60_000_000n);
    const file = path.join(sessionDir(fake.wallet), 'ledger.jsonl');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').trimEnd());
    await send(fake, 10_000_000n);
    expect(readLedger(fake.wallet).map((entry) => entry.usd)).toEqual([60, 10]);
  });

  it('a transfer marked ledgered whose entry is missing still counts', async () => {
    const fake = setup();
    await send(fake, 60_000_000n);
    expect(listTransfers(fake.wallet)[0].ledgered).toBe(true);
    fs.writeFileSync(path.join(sessionDir(fake.wallet), 'ledger.jsonl'), '');
    await expect(send(fake, 24n * 10n ** 15n, WETH)).rejects.toMatchObject({
      code: 'allowance_exhausted'
    });
  });

  it('a crash between the ledger write and the record update is not counted twice', async () => {
    const fake = setup();
    await send(fake, 60_000_000n);
    const [record] = listTransfers(fake.wallet);
    // As if the process died right after appending.
    fs.writeFileSync(
      path.join(sessionDir(fake.wallet), 'transfers', `${record.id}.json`),
      JSON.stringify({ ...record, ledgered: false })
    );
    expect(await send(fake, 30_000_000n)).toMatchObject({ usd: 30 });
    expect(readLedger(fake.wallet).map((entry) => entry.usd)).toEqual([60, 30]);
  });
});

describe('checks before a transfer (nothing is prepared)', () => {
  it('not_covered for a token without a grant', async () => {
    const fake = setup();
    const usdt = supportedTokens(137).find((t) => t.symbol === 'USDT')?.address ?? USDC;
    await expect(send(fake, 1n, usdt)).rejects.toMatchObject({ code: 'not_covered' });
    expect(fake.calls.prepare).toBe(0);
  });

  it('session_expired when the chain session has expired', async () => {
    const fake = setup({ expiresAt: '2020-01-01T00:00:00Z' });
    await expect(send(fake, 1n)).rejects.toMatchObject({ code: 'session_expired' });
  });

  it('allowance_exhausted when the on-chain limit has no room', async () => {
    const fake = setup({ used: 99_000_000n });
    await expect(send(fake, 2_000_000n)).rejects.toMatchObject({ code: 'allowance_exhausted' });
    expect(fake.calls.prepare).toBe(0);
  });

  it('allowance_exhausted when the USD total would pass the allowance', async () => {
    const fake = setup({ limit: 10n ** 12n });
    appendLedger({
      wallet: fake.wallet,
      entry: {
        ts: START.toISOString(),
        chainId: 137,
        token: WETH,
        symbol: 'WETH',
        amount: '1',
        usd: 99,
        purpose: 'trade'
      }
    });
    const error = await send(fake, 2_000_000n).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: 'allowance_exhausted' });
    expect(String(error)).toMatch(/past the \$100 allowance/);
  });

  it('not_connected when the approved plan is missing (no blind spending)', async () => {
    const fake = setup();
    fs.rmSync(path.join(sessionDir(fake.wallet), 'plan.json'));
    await expect(send(fake, 1n)).rejects.toMatchObject({ code: 'not_connected' });
    expect(fake.calls.prepare).toBe(0);
  });

  it('upstream_unavailable without a current price (never the price at approval)', async () => {
    const fake = setup();
    fake.deps.usdPrice = async () => undefined;
    await expect(send(fake, 10n ** 15n, WETH)).rejects.toMatchObject({
      code: 'upstream_unavailable'
    });
    expect(fake.calls.prepare).toBe(0);
    // Stablecoins are valued at $1 and don't need a price.
    expect(await send(fake, 1_000_000n)).toMatchObject({ usd: 1 });
  });

  it('counts dust against the allowance (rounds up to the cent)', async () => {
    const fake = setup();
    expect(await send(fake, 1n)).toMatchObject({ usd: 0.01 });
  });

  it('insufficient_balance when the wallet holds less', async () => {
    const fake = setup({ balance: 5n });
    await expect(send(fake, 6n)).rejects.toMatchObject({ code: 'insufficient_balance' });
  });
});

describe('probeSponsorship', () => {
  it.each([
    [{ sponsored: true }, true],
    [{ sponsored: false }, false]
  ])(
    'prepares a zero transfer to the wallet and never executes it (%j)',
    async (prepared, expected) => {
      const prepare = vi.fn(async () => ({
        txnId: 't',
        status: 'quoted' as const,
        feeOptions: [],
        expiresAt: '',
        ...prepared
      }));
      const result = await probeSponsorship({
        client: { prepareTransaction: prepare },
        walletId: 'wal-1',
        sessionId: 'sess-1',
        chainId: 137,
        token: USDC,
        walletAddress: WALLET_ADDRESS
      });
      expect(result.sponsored).toBe(expected);
      const call = prepare.mock.calls[0] as unknown as [{ data: `0x${string}` }];
      expect(decodeFunctionData({ abi: erc20Abi, data: call[0].data }).args).toEqual([
        WALLET_ADDRESS,
        0n
      ]);
    }
  );

  it('reports unknown (not unsponsored) when the probe fails for another reason', async () => {
    const result = await probeSponsorship({
      client: {
        prepareTransaction: async () => {
          throw httpError(500);
        }
      },
      walletId: 'wal-1',
      sessionId: 'sess-1',
      chainId: 137,
      token: USDC,
      walletAddress: WALLET_ADDRESS
    });
    expect(result.sponsored).toBeNull();
  });
});

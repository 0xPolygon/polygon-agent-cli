// Test-only stand-ins for OMS's remote access client and the engine's store.

import { getAddress } from 'viem';

import type { RemoteAccessSession, TransactionStatus } from '@polygonlabs/oms-wallet';

import { OMSWalletRequestError } from '@polygonlabs/oms-wallet';

import type { ApprovedPlan, EngineDeps, RacClient, TransferRecord } from './engine.ts';

import { buildPlan } from './plan.ts';

export const USDC = getAddress('0x3c499c542cef5e3811e1192ce70d8cc03d5c3359');
export const WETH = getAddress('0x7ceb23fd6bc0add59e62ac25578270cff1b9f619');
export const WALLET = getAddress('0xd384ea24ca0B3a5e4BB35935C611E3dCB68Fd08e');
export const TO = getAddress('0x1D17C0F90A0b3dFb5124C2FF56B33a0D2E202e1d');
export const START = new Date('2026-10-06T00:00:00Z');

export const PRICES = new Map<string, number>([
  [`137:${WETH.toLowerCase()}`, 2500],
  ['137:0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6', 60_000],
  ['137:0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', 0.25],
  ['8453:0x4200000000000000000000000000000000000006', 2500],
  ['8453:0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', 60_000]
]);

export const httpError = (status: number, name?: string) =>
  new OMSWalletRequestError({
    code: 'OMS_HTTP_ERROR',
    message: name ?? `HTTP ${status}`,
    status,
    upstreamError: { service: 'waas', status, ...(name ? { name } : {}) }
  });

export interface FakeState {
  used: bigint;
  limit: bigint;
  sponsored: boolean;
  expiresAt: string;
  statuses: Array<{ status: TransactionStatus; txnHash?: string }>;
  executeError?: unknown;
  prepareError?: unknown;
  balance: bigint;
}

export function fakeEngine(overrides: Partial<FakeState> = {}, allowanceUsd = 100) {
  let clock = START.getTime();
  const transfers = new Map<string, TransferRecord>();
  const plan = buildPlan({
    allowanceUsd,
    days: 30,
    heldChainIds: [],
    prices: PRICES,
    now: START
  });
  let approved: ApprovedPlan | null = { plan, approvedAt: START.toISOString() };
  const calls = {
    prepare: 0,
    execute: 0,
    status: 0,
    prepared: [] as { to: string; data: string }[]
  };
  const state: FakeState = {
    used: 0n,
    limit: 100_000_000n,
    sponsored: true,
    expiresAt: '2026-11-05T00:00:00Z',
    statuses: [{ status: 'executed', txnHash: '0xhash' }],
    balance: 1_000_000_000n,
    ...overrides
  };
  const session = (): RemoteAccessSession => ({
    sessionId: 'sess-1',
    walletId: 'wal-1',
    signerAddress: TO,
    chainId: 137,
    expiresAt: state.expiresAt,
    grants: [
      { kind: 'erc20Transfer', token: USDC, limit: state.limit, cumulative: true },
      { kind: 'erc20Transfer', token: WETH, limit: 10n ** 18n, cumulative: true }
    ]
  });
  const client: RacClient = {
    listSessions: async () => [session()],
    getSessionUsage: async () => [
      { grant: session().grants[0], used: state.used },
      { grant: session().grants[1], used: 0n }
    ],
    prepareTransaction: async (params) => {
      calls.prepare++;
      calls.prepared.push({ to: params.to, data: params.data ?? '0x' });
      if (state.prepareError) throw state.prepareError;
      return {
        txnId: `txn-${calls.prepare}`,
        status: 'quoted',
        feeOptions: [],
        sponsored: state.sponsored,
        expiresAt: ''
      };
    },
    executeTransaction: async () => {
      calls.execute++;
      if (state.executeError) throw state.executeError;
      return { status: 'pending' };
    },
    getTransactionStatus: async () => {
      calls.status++;
      return state.statuses.length > 1
        ? (state.statuses.shift() ?? { status: 'unknown' })
        : state.statuses[0];
    }
  } as RacClient;
  const deps: EngineDeps = {
    store: {
      approved: async () => approved,
      transfers: async () =>
        [...transfers.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      putTransfer: async (record) => void transfers.set(record.id, { ...record })
    },
    client,
    walletAddress: WALLET,
    keyExpiresAt: '2026-11-06T00:00:00Z',
    balanceOf: async () => state.balance,
    usdPrice: async () => 2500,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock)
  };
  return {
    deps,
    state,
    calls,
    transfers,
    advance: (ms: number) => {
      clock += ms;
    },
    unapprove: () => {
      approved = null;
    }
  };
}

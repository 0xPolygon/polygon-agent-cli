// One Durable Object per MCP connection that may move money: its own session
// key (a remote access credential the owner authorizes smart sessions for,
// like a CLI install's), the request nonce, the approved allowance, every
// transfer and trade it makes, and the owner's sign-in from connecting, kept
// for owner actions the owner approves on the site.
//
// One more per wallet (named `wallet:<address>`) holds what belongs to the
// wallet rather than to a connection: its Polymarket account, so every
// connection trades the same one.
//
// It runs one request at a time, so the nonce and the transfer records only
// ever move forward in order. It has no route: only this worker reaches it,
// through the AGENT_KEYS binding, by the key id kept in the connection's
// grant.

import type { Address } from 'viem';

import { getAddress, isAddress } from 'viem';

import {
  EthereumPrivateKeyCredentialSigner,
  findNetworkById,
  OMSWallet,
  RemoteAccessClient
} from '@polygonlabs/oms-wallet';

import type { OwnerSnapshot } from '../owner-signin.ts';
import type { EarnDeps } from './earn.ts';
import type { EngineDeps, TransferRecord } from './engine.ts';
import type { PlanJson } from './plan.ts';
import type { QuoteParams, TradeDeps, TradeRecord } from './trade.ts';
import type { PayParams, PendingAuthorization, X402Deps } from './x402.ts';

import { publishableKey } from '../oms-config.ts';
import { omsFromSnapshot } from '../owner-signin.ts';
import { deriveKey, openSealed, seal } from '../store.ts';
import {
  beginOwnerAction,
  decideAction,
  endOwnerAction,
  loadAction,
  proposeAction,
  viewAction
} from './actions.ts';
import { depositCall, listVaults, openVaults, positions, withdrawTxs } from './earn.ts';
import {
  checkTransfer,
  getSessions,
  probeSponsorship,
  reconcileTransfers,
  spentUsdSince,
  transfer
} from './engine.ts';
import { httpStatus, mapOmsError, MoneyError } from './errors.ts';
import { runAsOwner } from './owner-run.ts';
import { planFromJson, sessionMatchesPlan } from './plan.ts';
import {
  ownerAccess,
  pmAccount,
  pmBuy,
  pmCancel,
  pmDeposit,
  pmMarkets,
  pmRedeem,
  pmSell,
  pmWithdraw
} from './polymarket.ts';
import { rpcUrl } from './rpc.ts';
import { StoredNonceSigner } from './signer.ts';
import { chainLabel, findSupportedToken, parseChain, resolveSupportedSymbol } from './tokens.ts';
import {
  describeTrade,
  ensureOn,
  executeApprovedSwap,
  executeSwap,
  quoteSwap,
  tokenUnits
} from './trade.ts';
import { payAndFetch } from './x402.ts';

const APP_URL = 'https://agents.polygon.technology';
const APP_LOGO_URL = 'https://agents.polygon.technology/polygon-logo.png';
// The key outlives the sessions slightly, so a session never outlives its key.
const LIFETIME_MARGIN_SECONDS = 24 * 60 * 60;

export interface AgentKeyEnv {
  // This class's own namespace: a connection reaches its wallet's object.
  AGENT_KEYS?: DurableObjectNamespace;
  CREDENTIALS_KEY?: string;
  INDEXER_ACCESS_KEY?: string;
  OMS_PUBLISHABLE_KEY?: string;
  TRAILS_API_KEY?: string;
}

export interface KeyStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  deleteAll(): Promise<void>;
}

export interface KeyRecord {
  wallet: string;
  credentialId: string;
  registeredAt: string;
  expiresAt: string;
}

interface Approved {
  plan: PlanJson;
  approvedAt: string;
}

export interface ApprovedChain {
  chainId: number;
  sessionId: string;
  walletId: string;
}

// What the worker can ask for. Every request but `register` names the wallet,
// and is refused unless it is the one the key was registered for.
export type KeyRequest =
  | { op: 'register'; wallet: string; days: number; appName: string }
  | { op: 'approve'; wallet: string; plan: PlanJson; approved: ApprovedChain[] }
  | { op: 'status'; wallet: string }
  | { op: 'send'; wallet: string; token: string; chain?: string; to: string; amount: string }
  | ({ op: 'swap_quote'; wallet: string } & QuoteParams)
  // `approved`: the owner approved it on the site (it may be quoted again).
  | { op: 'swap'; wallet: string; intentId: string; approved?: boolean }
  | { op: 'swap_status'; wallet: string; intentId: string }
  | ({ op: 'pay_service'; wallet: string } & PayParams)
  | { op: 'earn_vaults'; wallet: string; chain?: string }
  | {
      op: 'earn_deposit';
      wallet: string;
      appName: string;
      vault: string;
      amount: string;
      chain?: string;
    }
  | {
      op: 'earn_withdraw';
      wallet: string;
      appName: string;
      vault: string;
      amount: string;
      chain?: string;
    }
  | { op: 'pm_markets'; wallet: string; query?: string }
  | { op: 'pm_account'; wallet: string; ownerRegion?: OwnerRegion }
  | { op: 'pm_deposit'; wallet: string; ownerRegion?: OwnerRegion; usd: string }
  | {
      op: 'pm_buy';
      wallet: string;
      ownerRegion?: OwnerRegion;
      market: string;
      outcome: string;
      usd: string;
      maxPrice?: number;
      limitPrice?: number;
    }
  | {
      op: 'pm_sell';
      wallet: string;
      ownerRegion?: OwnerRegion;
      market: string;
      outcome: string;
      shares: string;
      minPrice?: number;
      limitPrice?: number;
    }
  | {
      op: 'pm_cancel';
      wallet: string;
      ownerRegion?: OwnerRegion;
      orderId?: string;
      market?: string;
      all?: boolean;
    }
  | { op: 'pm_redeem'; wallet: string; ownerRegion?: OwnerRegion }
  | { op: 'pm_withdraw'; wallet: string; ownerRegion?: OwnerRegion; usd: string }
  | { op: 'owner_begin'; wallet: string; id: string }
  | {
      op: 'owner_end';
      wallet: string;
      id: string;
      result?: unknown;
      error?: ReturnType<MoneyError['toJSON']>;
    }
  // The owner's sign-in from connecting, handed over by the worker.
  | { op: 'keep_owner'; wallet: string; snapshot: OwnerSnapshot }
  // An approved owner action, sent with that sign-in.
  | { op: 'owner_run'; wallet: string; id: string }
  | { op: 'revoke'; wallet: string }
  // A spend the owner approves first (money/actions.ts): saved, not run.
  | { op: 'propose'; wallet: string; appName: string; request: SpendRequest }
  | { op: 'action'; wallet: string; id: string }
  | { op: 'decide'; wallet: string; id: string; approve: boolean };

// What the wallet's own object answers (it has no key): sealed values by name.
// `put_new` keeps a value already there and returns it. A lease lets one
// connection at a time use what's stored (it lapses at `until`, in ms).
export type WalletStoreRequest =
  | { op: 'wstore_get'; name: string }
  | { op: 'wstore_put'; name: string; value: string }
  | { op: 'wstore_put_new'; name: string; value: string }
  | { op: 'wstore_lease'; holder: string; until: number }
  | { op: 'wstore_release'; holder: string };

// Long enough for a Polymarket deposit's wait for the bridge.
const PM_LEASE_MS = 5 * 60 * 1000;

type WithoutWallet<T> = T extends unknown ? Omit<T, 'wallet'> : never;

// The requests that spend, and so can wait for the owner's approval.
export type SpendRequest =
  | Omit<Extract<KeyRequest, { op: 'send' }>, 'wallet'>
  | Omit<Extract<KeyRequest, { op: 'swap' }>, 'wallet'>
  | Omit<Extract<KeyRequest, { op: 'pay_service' }>, 'wallet'>
  | WithoutWallet<
      Extract<KeyRequest, { op: 'pm_deposit' | 'pm_buy' | 'pm_sell' | 'earn_deposit' }>
    >;

// Spends, and bets: on platforms where the owner approves each, these wait.
export const SPEND_OPS: ReadonlySet<string> = new Set([
  'send',
  'swap',
  'pay_service',
  'earn_deposit',
  'pm_deposit',
  'pm_buy',
  'pm_sell'
]);

export type OwnerRegion = { country: string | null; region: string | null };

// This site's own hosts: never paid as a service.
const OWN_HOSTS = [
  'agents.polygon.technology',
  'agentconnect.polygon.technology',
  'agentconnect.staging.polygon.technology'
];

export type KeyResponse =
  | { ok: true; value: unknown }
  | { ok: false; error: ReturnType<MoneyError['toJSON']> };

const NOT_CONNECTED = () =>
  new MoneyError({
    code: 'not_connected',
    message: 'This connection has no allowance to spend from.',
    hint: 'Ask the owner to connect again from this app.'
  });

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));

export class AgentKey {
  private readonly storage: KeyStorage;
  private queue: Promise<unknown> = Promise.resolve();
  private sealingKey?: Promise<CryptoKey>;
  // Swapped in tests.
  now = () => new Date();
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  clientFor?: (key: Uint8Array) => RemoteAccessClient;
  tradeDeps?: Partial<TradeDeps>;
  x402Overrides?: Partial<X402Deps>;
  earnOverrides?: Partial<EarnDeps>;
  pmOverrides?: Record<string, unknown>;
  // The wallet's object (tests); AGENT_KEYS otherwise.
  walletStore?: (wallet: string) => (req: WalletStoreRequest) => Promise<KeyResponse>;
  // The OMS client for the kept sign-in (tests).
  ownerOms?: (snapshot: OwnerSnapshot) => Pick<OMSWallet, 'wallet'>;

  constructor(
    state: { storage: KeyStorage },
    private readonly env: AgentKeyEnv
  ) {
    this.storage = state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const body = (await request.json()) as KeyRequest | WalletStoreRequest;
    // One request at a time, start to finish.
    const run = this.queue.then(() => this.handle(body));
    this.queue = run.catch(() => undefined);
    return Response.json(await run);
  }

  private async handle(req: KeyRequest | WalletStoreRequest): Promise<KeyResponse> {
    try {
      if (req.op.startsWith('wstore_')) {
        return { ok: true, value: await this.walletStoreOp(req as WalletStoreRequest) };
      }
      return { ok: true, value: await this.dispatch(req as KeyRequest) };
    } catch (error) {
      if (error instanceof MoneyError) return { ok: false, error: error.toJSON() };
      console.error('[agent-key]', error);
      return {
        ok: false,
        error: new MoneyError({
          code: 'upstream_error',
          message: error instanceof Error ? error.message : 'Something went wrong.'
        }).toJSON()
      };
    }
  }

  private async dispatch(req: KeyRequest): Promise<unknown> {
    if (req.op === 'register') return this.register(req);
    const record = await this.storage.get<KeyRecord>('record');
    if (!record || record.wallet !== req.wallet.toLowerCase()) throw NOT_CONNECTED();
    switch (req.op) {
      case 'approve':
        return this.approve(record, req.plan, req.approved);
      case 'status':
        return this.status(record);
      case 'send':
        return this.send(record, req);
      case 'swap_quote': {
        // A contract call is only ever this worker's (earn deposits), not an agent's.
        const { op: _op, wallet: _wallet, call: _call, ...params } = req;
        const { trade, warnings } = await quoteSwap(params, await this.deps(record));
        return {
          ...describeTrade(trade),
          ...(warnings.length ? { warnings } : {}),
          next: `Call swap with intent_id ${trade.intentId} before ${trade.expiresAt} to execute it.`
        };
      }
      case 'swap':
        return describeTrade(
          req.approved
            ? await executeApprovedSwap(await this.deps(record), req.intentId)
            : await executeSwap(await this.deps(record), req.intentId, { send: true })
        );
      case 'swap_status':
        return describeTrade(
          await executeSwap(await this.deps(record), req.intentId, { send: false })
        );
      case 'pay_service': {
        const { op: _op, wallet: _wallet, ...params } = req;
        return payAndFetch(params, await this.x402Deps(record), OWN_HOSTS);
      }
      case 'earn_vaults': {
        const deps = this.earnDeps();
        const vaults = await listVaults(req.chain, deps);
        const wallet = getAddress(record.wallet);
        const [open, held] = await Promise.all([
          openVaults(vaults.slice(0, 20), wallet, deps),
          positions(vaults, wallet, deps)
        ]);
        return { vaults: open.slice(0, 12), positions: held };
      }
      case 'earn_deposit':
        return this.earnDeposit(record, req);
      case 'earn_withdraw': {
        const { vault, txs, amount } = await withdrawTxs(
          {
            vault: req.vault,
            amount: req.amount,
            chain: req.chain,
            wallet: getAddress(record.wallet)
          },
          this.earnDeps()
        );
        return this.viewAction(
          await proposeAction({
            storage: this.storage,
            request: { op: req.op },
            title: `Withdraw ${amount} ${vault.asset.symbol} from a vault`,
            details: [
              { label: 'Vault', value: `${vault.name} (${vault.address})` },
              { label: 'Network', value: vault.chain },
              { label: 'To', value: 'This wallet' }
            ],
            appName: req.appName,
            owner: txs,
            now: this.now()
          })
        );
      }
      case 'pm_account':
      case 'pm_deposit':
      case 'pm_buy':
      case 'pm_sell':
      case 'pm_cancel':
      case 'pm_redeem':
      case 'pm_withdraw':
        return this.withPmLease(record, () => this.polymarket(record, req));
      case 'pm_markets':
        return pmMarkets({ query: req.query }, await this.pmDeps(record, undefined));
      case 'owner_begin': {
        const deps = await this.deps(record);
        return beginOwnerAction(this.storage, req.id, this.now(), (f) =>
          ensureOn(deps, { chainId: f.chainId, symbol: f.symbol, amount: BigInt(f.amount) })
        );
      }
      case 'owner_end':
        return this.viewAction(
          await endOwnerAction(
            this.storage,
            req.id,
            req.error ? { error: req.error } : { result: req.result },
            this.now()
          )
        );
      case 'keep_owner':
        await this.storage.put(
          'owner-session',
          await seal(await this.sealer(), 'owner-session', req.snapshot)
        );
        return { kept: true };
      case 'owner_run':
        return this.ownerRun(record, req.id);
      case 'revoke':
        return this.revoke(record);
      case 'propose':
        return this.propose(record, req.appName, req.request);
      case 'action':
        return this.viewAction(await loadAction(this.storage, req.id, this.now()));
      case 'decide':
        return this.viewAction(
          await decideAction<SpendRequest>({
            storage: this.storage,
            id: req.id,
            approve: req.approve,
            // Runs as if the agent had asked, within the allowance like any spend.
            run: (request) =>
              this.dispatch({
                ...request,
                ...(request.op === 'swap' ? { approved: true } : {}),
                wallet: record.wallet
              } as KeyRequest),
            now: this.now
          })
        );
    }
  }

  // Checks what can be checked now (so the owner isn't asked to approve
  // something that would fail), then saves it for the owner.
  private async propose(record: KeyRecord, appName: string, request: SpendRequest) {
    let title: string;
    let details: { label: string; value: string }[];
    if (request.op === 'send') {
      const { chainId, token, to, amount } = this.resolveSend(record, request);
      await checkTransfer({ chainId, token: token.address, amount, deps: await this.deps(record) });
      title = `Send ${request.amount} ${token.symbol}`;
      details = [
        { label: 'To', value: to },
        { label: 'Network', value: chainLabel(chainId) }
      ];
    } else if (request.op === 'pm_deposit') {
      title = `Move $${request.usd} to Polymarket`;
      details = [
        { label: 'From', value: 'USDC on Polygon, from the allowance' },
        { label: 'Note', value: 'Money on Polymarket is outside the allowance' }
      ];
    } else if (request.op === 'pm_buy') {
      title = `Bet $${request.usd} on "${request.outcome}"`;
      details = [
        { label: 'Market', value: request.market },
        ...(request.limitPrice !== undefined
          ? [{ label: 'Limit price', value: String(request.limitPrice) }]
          : request.maxPrice !== undefined
            ? [{ label: 'Pay at most', value: `${request.maxPrice} a share` }]
            : [])
      ];
    } else if (request.op === 'pm_sell') {
      title = `Sell ${request.shares} "${request.outcome}" shares on Polymarket`;
      details = [{ label: 'Market', value: request.market }];
    } else if (request.op === 'earn_deposit') {
      const { vault, amount } = await depositCall(
        { ...request, wallet: getAddress(record.wallet) },
        this.earnDeps()
      );
      title = `Deposit ${amount} ${vault.asset.symbol} to earn about ${vault.apy}% a year`;
      details = [
        { label: 'Vault', value: `${vault.name} (${vault.address})` },
        { label: 'Network', value: vault.chain },
        { label: 'Rate today', value: `${vault.apy}% a year, not fixed` }
      ];
    } else if (request.op === 'pay_service') {
      title = `Pay up to $${request.maxUsd} for a web service`;
      details = [
        { label: 'Service', value: new URL(request.url).hostname },
        {
          label: 'Request',
          value: `${(request.method ?? 'GET').toUpperCase()} ${request.url}`.slice(0, 200)
        }
      ];
    } else {
      const trade = await this.storage.get<TradeRecord>(`trade:${request.intentId}`);
      if (!trade || trade.state !== 'quoted') {
        throw new MoneyError({
          code: 'quote_not_found',
          message: `No open quote ${request.intentId} on this connection.`,
          hint: 'Quote again with swap_quote.'
        });
      }
      const view = describeTrade(trade) as {
        from: { amount: string; token: string; chain: string };
        to: { expected: string; minimum: string; token: string; chain: string };
        usd: { fees: number };
      };
      title = `Swap ${view.from.amount} ${view.from.token} for about ${Number(view.to.expected).toPrecision(4)} ${view.to.token}`;
      details = [
        { label: 'From', value: `${view.from.amount} ${view.from.token} on ${view.from.chain}` },
        { label: 'At least', value: `${view.to.minimum} ${view.to.token} on ${view.to.chain}` },
        { label: 'Fees', value: `$${view.usd.fees.toFixed(2)}` }
      ];
    }
    const action = await proposeAction({
      storage: this.storage,
      request,
      title,
      details,
      appName,
      now: this.now()
    });
    return this.viewAction(action);
  }

  // An owner action needs no sign-in on the page while the kept one works.
  private async viewAction(action: Parameters<typeof viewAction>[0]) {
    const view = viewAction(action);
    return view.ownerSignIn && (await this.storage.get('owner-session'))
      ? { ...view, ownerSignIn: false }
      : view;
  }

  // --- Polymarket -----------------------------------------------------------------

  private async polymarket(
    record: KeyRecord,
    req: Extract<KeyRequest, { op: `pm_${string}` }>
  ): Promise<unknown> {
    switch (req.op) {
      case 'pm_account':
        return pmAccount(await this.pmDeps(record, req.ownerRegion));
      case 'pm_deposit': {
        const deps = await this.pmDeps(record, req.ownerRegion);
        await this.settleStuckDeposit(record);
        // Polymarket is funded from Polygon USDC: bridge it there first if the
        // wallet holds it elsewhere (only where the owner may use Polymarket).
        const units = /^\d+(\.\d{1,6})?$/.test(req.usd.trim()) ? tokenUnits(req.usd, 6) : 0n;
        const bridged =
          units >= 2_000_000n && ownerAccess(deps.ownerRegion) === 'open'
            ? await ensureOn(await this.deps(record), {
                chainId: 137,
                symbol: 'USDC',
                amount: units
              })
            : null;
        const result = await pmDeposit({ usd: req.usd }, deps);
        return bridged ? { bridged, ...(result as object) } : result;
      }
      case 'pm_buy': {
        const { op: _op, wallet: _w, ownerRegion, ...p } = req;
        return pmBuy(p, await this.pmDeps(record, ownerRegion));
      }
      case 'pm_sell': {
        const { op: _op, wallet: _w, ownerRegion, ...p } = req;
        return pmSell(p, await this.pmDeps(record, ownerRegion));
      }
      case 'pm_cancel': {
        const { op: _op, wallet: _w, ownerRegion, ...p } = req;
        return pmCancel(p, await this.pmDeps(record, ownerRegion));
      }
      case 'pm_redeem':
        return pmRedeem(await this.pmDeps(record, req.ownerRegion));
      case 'pm_withdraw':
        return pmWithdraw({ usd: req.usd }, await this.pmDeps(record, req.ownerRegion));
      default:
        throw new MoneyError({ code: 'invalid_input', message: `Unknown request ${req.op}.` });
    }
  }

  // The wallet's object: its Polymarket account lives there, for every connection.
  private walletObject(wallet: string): (req: WalletStoreRequest) => Promise<KeyResponse> {
    if (this.walletStore) return this.walletStore(wallet);
    if (!this.env.AGENT_KEYS) throw new Error('AGENT_KEYS is not bound');
    const call = agentKey(this.env.AGENT_KEYS, `wallet:${wallet.toLowerCase()}`);
    return (req) => call(req as unknown as KeyRequest);
  }

  private async walletCall<T>(wallet: string, req: WalletStoreRequest): Promise<T> {
    const res = await this.walletObject(wallet)(req);
    if (!res.ok) {
      throw new MoneyError({
        code: res.error.code,
        message: res.error.error,
        hint: res.error.hint
      });
    }
    return res.value as T;
  }

  // One connection at a time uses the wallet's Polymarket account.
  private async withPmLease<T>(record: KeyRecord, fn: () => Promise<T>): Promise<T> {
    const holder = record.credentialId;
    const held = await this.walletCall<boolean>(record.wallet, {
      op: 'wstore_lease',
      holder,
      until: this.now().getTime() + PM_LEASE_MS
    });
    if (!held) {
      throw new MoneyError({
        code: 'rate_limited',
        message: 'Another connection to this wallet is using Polymarket right now.',
        hint: 'Try again in a minute.'
      });
    }
    try {
      return await fn();
    } finally {
      await this.walletCall(record.wallet, { op: 'wstore_release', holder }).catch(() => {});
    }
  }

  // Only the wallet's object answers these: never a connection's own.
  private async walletStoreOp(req: WalletStoreRequest): Promise<unknown> {
    if (await this.storage.get('record')) {
      throw new MoneyError({ code: 'invalid_input', message: 'Not a wallet store.' });
    }
    const name = (n: string) => `w:${n}`;
    switch (req.op) {
      case 'wstore_get':
        return (await this.storage.get<string>(name(req.name))) ?? null;
      case 'wstore_put':
        await this.storage.put(name(req.name), req.value);
        return true;
      case 'wstore_put_new': {
        const existing = await this.storage.get<string>(name(req.name));
        if (existing) return existing;
        await this.storage.put(name(req.name), req.value);
        return req.value;
      }
      case 'wstore_lease': {
        const lease = await this.storage.get<{ holder: string; until: number }>('lease');
        if (lease && lease.holder !== req.holder && lease.until > this.now().getTime()) {
          return false;
        }
        await this.storage.put('lease', { holder: req.holder, until: req.until });
        return true;
      }
      case 'wstore_release': {
        const lease = await this.storage.get<{ holder: string; until: number }>('lease');
        if (lease?.holder === req.holder) await this.storage.put('lease', null);
        return true;
      }
    }
  }

  // --- earning ------------------------------------------------------------------

  private earnDeps(): EarnDeps {
    return {
      trailsKey: this.env.TRAILS_API_KEY ?? '',
      rpcUrl: (id: number) => rpcUrl(id, this.env.INDEXER_ACCESS_KEY),
      ...this.earnOverrides
    };
  }

  // Through Trails, paid with the key like a trade: from whichever covered
  // chain holds the stablecoin, into the vault, the shares minted to the wallet.
  private async earnDeposit(record: KeyRecord, req: Extract<KeyRequest, { op: 'earn_deposit' }>) {
    const { vault, amount, call } = await depositCall(
      { vault: req.vault, amount: req.amount, chain: req.chain, wallet: getAddress(record.wallet) },
      this.earnDeps()
    );
    const deps = await this.deps(record);
    const { trade } = await quoteSwap(
      {
        from: vault.asset.symbol,
        to: vault.asset.symbol,
        toAmount: amount,
        toChain: String(vault.chainId),
        call
      },
      deps
    );
    const done = await executeSwap(deps, trade.intentId, { send: true });
    const deposit = { amount, token: vault.asset.symbol, vault: vault.name, chain: vault.chain };
    if (done.state === 'completed') {
      return {
        deposited: deposit,
        rateToday: `${vault.apy}% a year, not fixed`,
        ...describeTrade(done)
      };
    }
    // Not deposited (yet): say so, with where the money is.
    return {
      notDeposited: deposit,
      next:
        done.state === 'refunded'
          ? "The vault didn't take it, so Trails sent the stablecoin back to the wallet."
          : done.state === 'failed'
            ? 'It failed; check the wallet before trying again.'
            : `Still on its way: check with swap_status and intent_id ${done.intentId}.`,
      ...describeTrade(done)
    };
  }

  // Sends an approved owner action with the owner's sign-in from connecting.
  // If that has run out, nothing is marked: the owner signs in on the page.
  private async ownerRun(record: KeyRecord, id: string) {
    const sealed = await this.storage.get<string>('owner-session');
    const signInNeeded = () =>
      new MoneyError({
        code: 'owner_signin_needed',
        message: 'Sign in on this page to approve it: the sign-in from connecting has run out.'
      });
    if (!sealed) throw signInNeeded();
    const snapshot = await openSealed<OwnerSnapshot>(await this.sealer(), 'owner-session', sealed);
    const oms = this.ownerOms
      ? this.ownerOms(snapshot)
      : omsFromSnapshot(this.publishableKey(), snapshot);
    const save = async () =>
      this.storage.put('owner-session', await seal(await this.sealer(), 'owner-session', snapshot));
    try {
      await oms.wallet.listWallets();
    } catch (error) {
      const status = httpStatus(error);
      const mapped = mapOmsError(error);
      if (
        status === 401 ||
        status === 403 ||
        (mapped instanceof MoneyError && mapped.code === 'session_expired')
      ) {
        await this.storage.put('owner-session', null);
        throw signInNeeded();
      }
      throw error;
    }
    const deps = await this.deps(record);
    const txs = await beginOwnerAction(this.storage, id, this.now(), (f) =>
      ensureOn(deps, { chainId: f.chainId, symbol: f.symbol, amount: BigInt(f.amount) })
    );
    let outcome: { result: unknown } | { error: ReturnType<MoneyError['toJSON']> };
    try {
      outcome = {
        result: await runAsOwner({ oms, wallet: record.wallet, ...txs })
      };
    } catch (error) {
      console.error('[agent-key] owner run', error);
      outcome = {
        error:
          error instanceof MoneyError
            ? error.toJSON()
            : new MoneyError({
                code: 'upstream_error',
                message: error instanceof Error ? error.message : 'It failed.'
              }).toJSON()
      };
    }
    await save();
    return this.viewAction(await endOwnerAction(this.storage, id, outcome, this.now()));
  }

  // --- the key -------------------------------------------------------------------

  private sealer(): Promise<CryptoKey> {
    if (!this.env.CREDENTIALS_KEY) throw new Error('CREDENTIALS_KEY is not set');
    this.sealingKey ??= deriveKey(this.env.CREDENTIALS_KEY);
    return this.sealingKey;
  }

  private async privateKey(): Promise<Uint8Array | null> {
    const sealed = await this.storage.get<string>('key');
    return sealed
      ? unhex(await openSealed<string>(await this.sealer(), 'agent-key', sealed))
      : null;
  }

  private publishableKey(): string {
    return publishableKey(this.env);
  }

  private client(key: Uint8Array): RemoteAccessClient {
    if (this.clientFor) return this.clientFor(key);
    return new RemoteAccessClient({
      publishableKey: this.publishableKey(),
      credentialSigner: new StoredNonceSigner(key, {
        get: async () => BigInt((await this.storage.get<string>('nonce')) ?? '0'),
        put: (nonce) => this.storage.put('nonce', nonce.toString())
      })
    });
  }

  private async register(req: Extract<KeyRequest, { op: 'register' }>): Promise<KeyRecord> {
    const existing = await this.storage.get<KeyRecord>('record');
    if (existing) {
      throw new MoneyError({ code: 'invalid_input', message: 'This key is already registered.' });
    }
    const key = crypto.getRandomValues(new Uint8Array(32));
    await this.storage.put('key', await seal(await this.sealer(), 'agent-key', hex(key)));
    const lifetimeSeconds = req.days * 86_400 + LIFETIME_MARGIN_SECONDS;
    const { credentialId } = await this.client(key).registerCredential({
      lifetimeSeconds,
      metadata: {
        appName: `Open Money Agent (${req.appName})`.slice(0, 100),
        appUrl: APP_URL,
        appLogoUrl: APP_LOGO_URL,
        custom: { app: 'open-money-agent-mcp' }
      }
    });
    const now = this.now();
    const record: KeyRecord = {
      wallet: req.wallet.toLowerCase(),
      credentialId,
      registeredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + lifetimeSeconds * 1000).toISOString()
    };
    await this.storage.put('record', record);
    return record;
  }

  // Reads the sessions the owner just approved back through the key, checks
  // each is exactly what was planned, and checks gas sponsorship on Polygon.
  // Returns the chains kept; the worker revokes the rest as the owner.
  private async approve(
    record: KeyRecord,
    planJson: PlanJson,
    approved: ApprovedChain[]
  ): Promise<{ kept: ApprovedChain[]; dropped: { chainId: number; reason: string }[] }> {
    const key = await this.privateKey();
    if (!key) throw NOT_CONNECTED();
    const client = this.client(key);
    const plan = planFromJson(planJson);
    const listed = await client.listSessions();
    const kept: ApprovedChain[] = [];
    const dropped: { chainId: number; reason: string }[] = [];
    for (const chain of approved) {
      const planned = plan.chains.find((c) => c.chainId === chain.chainId);
      const session = listed.find((s) => s.sessionId === chain.sessionId);
      if (
        !planned ||
        !session ||
        !sessionMatchesPlan({ session, planned, expiresAt: plan.expiresAt })
      ) {
        dropped.push({
          chainId: chain.chainId,
          reason: "the approved session didn't match the plan"
        });
        continue;
      }
      if (chain.chainId === 137) {
        const token = (planned.grants.find((g) => g.kind === 'usd') ?? planned.grants[0]).token;
        const probe = await probeSponsorship({
          client,
          walletId: chain.walletId,
          sessionId: chain.sessionId,
          chainId: chain.chainId,
          token,
          walletAddress: record.wallet
        });
        if (probe.sponsored === false) {
          dropped.push({ chainId: chain.chainId, reason: "OMS doesn't sponsor gas there" });
          continue;
        }
      }
      kept.push(chain);
    }
    const approvedPlan: Approved = {
      plan: {
        ...planJson,
        chains: planJson.chains
          .map((c) => {
            const ok = kept.find((k) => k.chainId === c.chainId);
            return ok ? { ...c, sessionId: ok.sessionId, walletId: ok.walletId } : null;
          })
          .filter((c) => c !== null)
      },
      approvedAt: this.now().toISOString()
    };
    if (kept.length > 0) await this.storage.put('approved', approvedPlan);
    return { kept, dropped };
  }

  private async revoke(record: KeyRecord): Promise<{ revoked: boolean }> {
    // The owner's kept sign-in goes first: signed out at OMS, not only forgotten.
    const sealed = await this.storage.get<string>('owner-session');
    if (sealed) {
      try {
        const snapshot = await openSealed<OwnerSnapshot>(
          await this.sealer(),
          'owner-session',
          sealed
        );
        const oms = this.ownerOms
          ? this.ownerOms(snapshot)
          : omsFromSnapshot(this.publishableKey(), snapshot);
        await oms.wallet.signOut();
      } catch {
        // Already gone at OMS, or unreachable: it's deleted with the rest below.
      }
      await this.storage.put('owner-session', null);
    }
    const key = await this.privateKey();
    let revoked = Date.parse(record.expiresAt) <= this.now().getTime();
    if (key && !revoked) {
      try {
        await this.client(key).revokeCredential({ credentialId: record.credentialId });
        revoked = true;
      } catch (error) {
        // 401: OMS no longer accepts the key, so it has no access left.
        revoked = httpStatus(error) === 401;
      }
    }
    if (revoked) await this.storage.deleteAll();
    return { revoked };
  }

  // --- spending -------------------------------------------------------------------

  private async deps(record: KeyRecord): Promise<TradeDeps> {
    const key = await this.privateKey();
    if (!key) throw NOT_CONNECTED();
    const storage = this.storage;
    const { TrailsApi } = await import('@0xtrails/api');
    const trails = new TrailsApi(this.env.TRAILS_API_KEY ?? '');
    // Balances through the OMS indexer, the same reads the CLI makes. Its
    // client needs no sign-in; the signer here is a throwaway.
    const indexer = () =>
      new OMSWallet({
        publishableKey: this.publishableKey(),
        storage: memoryStorage(),
        credentialSigner: new EthereumPrivateKeyCredentialSigner(
          crypto.getRandomValues(new Uint8Array(32))
        )
      }).indexer;
    const engine: EngineDeps = {
      store: {
        approved: async () => {
          const approved = await storage.get<Approved>('approved');
          return approved
            ? { plan: planFromJson(approved.plan), approvedAt: approved.approvedAt }
            : null;
        },
        transfers: async () =>
          [...(await storage.list<TransferRecord>({ prefix: 'transfer:' })).values()].sort((a, b) =>
            a.createdAt.localeCompare(b.createdAt)
          ),
        putTransfer: (r) => storage.put(`transfer:${r.id}`, r)
      },
      client: this.client(key),
      walletAddress: getAddress(record.wallet),
      keyExpiresAt: record.expiresAt,
      balanceOf: async ({ chainId, token }) => {
        const network = findNetworkById(chainId);
        if (!network) return 0n;
        const res = await indexer().getBalances({
          walletAddress: record.wallet,
          networks: [network],
          contractAddresses: [token]
        });
        const entry = res.balances.find(
          (b) => b.contractAddress.toLowerCase() === token.toLowerCase()
        );
        return entry ? BigInt(entry.balance) : 0n;
      },
      usdPrice: async ({ chainId, token }) => {
        try {
          const res = await trails.getTokenPrices({ tokens: [{ chainId, tokenAddress: token }] });
          const price = res.tokenPrices?.[0]?.priceUsd;
          return typeof price === 'number' && price > 0 ? price : undefined;
        } catch {
          return undefined;
        }
      },
      sleep: this.sleep,
      now: this.now,
      rpcUrl: (chainId) => rpcUrl(chainId, this.env.INDEXER_ACCESS_KEY)
    };
    return {
      ...engine,
      trails,
      trades: {
        trade: async (id) => (await storage.get<TradeRecord>(`trade:${id}`)) ?? null,
        putTrade: (t) => storage.put(`trade:${t.intentId}`, t),
        trades: async () => [...(await storage.list<TradeRecord>({ prefix: 'trade:' })).values()]
      },
      ...this.tradeDeps
    };
  }

  // The connection's x402 signer: its own key, made on first use.
  private async x402Deps(record: KeyRecord) {
    const sealer = await this.sealer();
    const storage = this.storage;
    return {
      ...(await this.deps(record)),
      signerKey: async (): Promise<`0x${string}`> => {
        const sealed = await storage.get<string>('x402-key');
        if (sealed) return `0x${await openSealed<string>(sealer, 'x402-key', sealed)}`;
        const key = hex(crypto.getRandomValues(new Uint8Array(32)));
        await storage.put('x402-key', await seal(sealer, 'x402-key', key));
        return `0x${key}`;
      },
      ensureFunds: async ({
        chainId,
        asset,
        amount
      }: {
        chainId: number;
        asset: string;
        amount: bigint;
      }) => {
        const symbol = findSupportedToken({ chainId, address: asset })?.symbol;
        if (symbol) await ensureOn(await this.deps(record), { chainId, symbol, amount });
      },
      x402: {
        pending: async () => [
          ...(await storage.list<PendingAuthorization>({ prefix: 'x402:' })).values()
        ],
        putPending: (p: PendingAuthorization) => storage.put(`x402:${p.id}`, p)
      },
      ...this.x402Overrides
    };
  }

  // Polymarket: the wallet's trading key and account, sealed in the wallet's
  // object, funded from this connection's allowance through Polymarket's bridge.
  private async pmDeps(record: KeyRecord, ownerRegion: OwnerRegion | undefined) {
    const sealer = await this.sealer();
    const wallet = record.wallet;
    const deps = await this.deps(record);
    const USDC = getAddress('0x3c499c542cef5e3811e1192ce70d8cc03d5c3359');
    return {
      store: {
        get: async (name: string) => {
          const sealed = await this.walletCall<string | null>(wallet, { op: 'wstore_get', name });
          return sealed ? openSealed<string>(sealer, name, sealed) : null;
        },
        put: async (name: string, value: string) => {
          await this.walletCall(wallet, {
            op: 'wstore_put',
            name,
            value: await seal(sealer, name, value)
          });
        },
        putNew: async (name: string, value: string) =>
          openSealed<string>(
            sealer,
            name,
            await this.walletCall<string>(wallet, {
              op: 'wstore_put_new',
              name,
              value: await seal(sealer, name, value)
            })
          )
      },
      walletAddress: getAddress(record.wallet),
      ownerRegion: ownerRegion ?? { country: null, region: null },
      sendUsdc: async ({ to, amount }: { to: `0x${string}`; amount: bigint }) =>
        transfer({
          chainId: 137,
          token: USDC,
          to,
          amount,
          purpose: 'trade',
          ref: 'polymarket-deposit',
          deps
        }),
      usdcBalance: () => deps.balanceOf({ chainId: 137, token: USDC }),
      polygonRpcUrl: rpcUrl(137, this.env.INDEXER_ACCESS_KEY),
      now: this.now,
      sleep: this.sleep,
      ...this.pmOverrides
    };
  }

  // A deposit recorded as 'sending' whose transfer never left (stopped between
  // the record and the send) would hold up every later deposit. The engine's
  // own records say: an executed transfer for it means it was sent; none, or
  // only ones that certainly moved nothing, means it can be cleared.
  private async settleStuckDeposit(record: KeyRecord): Promise<void> {
    const pm = await this.pmDeps(record, undefined);
    const raw = await pm.store.get('pm-deposit');
    if (!raw) return;
    const pending = JSON.parse(raw) as { status: string; sentAt: string; txHash: string | null };
    if (pending.status !== 'sending') return;
    const deps = await this.deps(record);
    await reconcileTransfers(deps);
    const since = Date.parse(pending.sentAt) - 60_000;
    const transfers = (await deps.store.transfers()).filter(
      (t) => t.ref === 'polymarket-deposit' && Date.parse(t.createdAt) >= since
    );
    const sent = transfers.find((t) => t.state === 'executed' && t.txHash);
    if (sent) {
      await pm.store.put(
        'pm-deposit',
        JSON.stringify({ ...pending, status: 'sent', txHash: sent.txHash })
      );
    } else if (transfers.every((t) => t.state === 'failed' && t.neverSent)) {
      await pm.store.put('pm-deposit', '');
    }
  }

  private async status(record: KeyRecord) {
    const approved = await this.storage.get<Approved>('approved');
    if (!approved) throw NOT_CONNECTED();
    const deps = await this.deps(record);
    const spent = spentUsdSince({
      transfers: await deps.store.transfers(),
      since: approved.approvedAt
    });
    const sessions = await getSessions({ deps });
    const plan = planFromJson(approved.plan);
    return {
      allowanceUsd: plan.allowanceUsd,
      spentUsd: spent,
      remainingUsd: Math.max(0, Math.round((plan.allowanceUsd - spent) * 100) / 100),
      expiresAt: plan.expiresAt,
      expired: Date.parse(plan.expiresAt) <= this.now().getTime(),
      chains: plan.chains.map((chain) => ({
        chain: chainLabel(chain.chainId),
        tokens: chain.grants.map((g) => g.symbol),
        active: sessions.some((s) => s.chainId === chain.chainId && !s.expired)
      }))
    };
  }

  private resolveSend(record: KeyRecord, req: Omit<Extract<KeyRequest, { op: 'send' }>, 'wallet'>) {
    const chainId = req.chain ? parseChain(req.chain) : 137;
    if (chainId === undefined) {
      throw new MoneyError({ code: 'invalid_input', message: `Unknown chain: ${req.chain}.` });
    }
    const token =
      resolveSupportedSymbol({ chainId, symbol: req.token }) ??
      (isAddress(req.token) ? findSupportedToken({ chainId, address: req.token }) : undefined);
    if (!token) {
      throw new MoneyError({
        code: 'not_covered',
        message: `${req.token} on ${chainLabel(chainId)} isn't one of the tokens this connection can send.`
      });
    }
    if (!isAddress(req.to)) {
      throw new MoneyError({
        code: 'invalid_input',
        message: `Not an address: "${req.to}". Give a 0x address.`
      });
    }
    const to: Address = getAddress(req.to);
    if (to.toLowerCase() === record.wallet) {
      throw new MoneyError({ code: 'invalid_input', message: "That's this wallet's own address." });
    }
    return { chainId, token, to, amount: tokenUnits(req.amount, token.decimals) };
  }

  private async send(record: KeyRecord, req: Extract<KeyRequest, { op: 'send' }>) {
    const { chainId, token, to, amount } = this.resolveSend(record, req);
    const deps = await this.deps(record);
    const bridged =
      token.kind === 'usd' ? await ensureOn(deps, { chainId, symbol: token.symbol, amount }) : null;
    const result = await transfer({
      chainId,
      token: token.address,
      to,
      amount,
      purpose: 'send',
      deps
    });
    const network = findNetworkById(chainId);
    return {
      sent: { amount: req.amount, token: token.symbol, chain: chainLabel(chainId), to },
      ...(bridged ? { bridged } : {}),
      usd: result.usd,
      txHash: result.txHash,
      ...(network
        ? { explorerUrl: `${network.explorerUrl.replace(/\/+$/, '')}/tx/${result.txHash}` }
        : {})
    };
  }
}

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    get: (k: string) => data.get(k) ?? null,
    set: (k: string, v: string) => void data.set(k, v),
    delete: (k: string) => void data.delete(k)
  };
}

/** A connection's key, by the id kept in its grant. */
export function agentKey(ns: DurableObjectNamespace, keyId: string) {
  const stub = ns.get(ns.idFromName(keyId));
  return async (req: KeyRequest): Promise<KeyResponse> => {
    const res = await stub.fetch('https://agent-key/', {
      method: 'POST',
      body: JSON.stringify(req)
    });
    if (!res.ok) throw new Error(`agent key answered ${res.status}`);
    return (await res.json()) as KeyResponse;
  };
}

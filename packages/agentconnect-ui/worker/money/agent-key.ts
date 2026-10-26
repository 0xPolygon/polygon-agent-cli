// One Durable Object per MCP connection that may move money: its own session
// key (a remote access credential the owner authorizes smart sessions for,
// like a CLI install's), the request nonce, the approved allowance, and every
// transfer and trade it makes.
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

import type { EngineDeps, TransferRecord } from './engine.ts';
import type { PlanJson } from './plan.ts';
import type { QuoteParams, TradeDeps, TradeRecord } from './trade.ts';

import { publishableKey } from '../oms-config.ts';
import { deriveKey, openSealed, seal } from '../store.ts';
import { getSessions, probeSponsorship, spentUsdSince, transfer } from './engine.ts';
import { httpStatus, MoneyError } from './errors.ts';
import { planFromJson, sessionMatchesPlan } from './plan.ts';
import { StoredNonceSigner } from './signer.ts';
import { chainLabel, findSupportedToken, parseChain, resolveSupportedSymbol } from './tokens.ts';
import { describeTrade, executeSwap, quoteSwap, tokenUnits } from './trade.ts';

const APP_URL = 'https://agents.polygon.technology';
const APP_LOGO_URL = 'https://agents.polygon.technology/polygon-logo.png';
// The key outlives the sessions slightly, so a session never outlives its key.
const LIFETIME_MARGIN_SECONDS = 24 * 60 * 60;

export interface AgentKeyEnv {
  CREDENTIALS_KEY?: string;
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
  | { op: 'swap'; wallet: string; intentId: string }
  | { op: 'swap_status'; wallet: string; intentId: string }
  | { op: 'revoke'; wallet: string };

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

  constructor(
    state: { storage: KeyStorage },
    private readonly env: AgentKeyEnv
  ) {
    this.storage = state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const body = (await request.json()) as KeyRequest;
    // One request at a time, start to finish.
    const run = this.queue.then(() => this.handle(body));
    this.queue = run.catch(() => undefined);
    return Response.json(await run);
  }

  private async handle(req: KeyRequest): Promise<KeyResponse> {
    try {
      return { ok: true, value: await this.dispatch(req) };
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
        const { op: _op, wallet: _wallet, ...params } = req;
        const { trade, warnings } = await quoteSwap(params, await this.deps(record));
        return {
          ...describeTrade(trade),
          ...(warnings.length ? { warnings } : {}),
          next: `Call swap with intent_id ${trade.intentId} before ${trade.expiresAt} to execute it.`
        };
      }
      case 'swap':
        return describeTrade(
          await executeSwap(await this.deps(record), req.intentId, { send: true })
        );
      case 'swap_status':
        return describeTrade(
          await executeSwap(await this.deps(record), req.intentId, { send: false })
        );
      case 'revoke':
        return this.revoke(record);
    }
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
      now: this.now
    };
    return {
      ...engine,
      trails,
      trades: {
        trade: async (id) => (await storage.get<TradeRecord>(`trade:${id}`)) ?? null,
        putTrade: (t) => storage.put(`trade:${t.intentId}`, t)
      },
      ...this.tradeDeps
    };
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

  private async send(record: KeyRecord, req: Extract<KeyRequest, { op: 'send' }>) {
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
    const amount = tokenUnits(req.amount, token.decimals);
    const result = await transfer({
      chainId,
      token: token.address,
      to,
      amount,
      purpose: 'send',
      deps: await this.deps(record)
    });
    const network = findNetworkById(chainId);
    return {
      sent: { amount: req.amount, token: token.symbol, chain: chainLabel(chainId), to },
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

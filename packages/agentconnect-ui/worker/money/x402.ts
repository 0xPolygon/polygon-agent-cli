// Paying for web services with x402, from the connection's allowance. The same
// flow as the CLI's x402-pay: the service names its price in a 402; the
// connection's x402 signer (its own key, kept with the connection) signs an
// EIP-3009 authorization for exactly that, and the agent wallet funds the
// signer with one transfer for whatever it's short, within the allowance.
// Leftovers stay with the signer and pay for later calls.

import type { Address } from 'viem';

import { createPublicClient, erc20Abi, formatUnits, getAddress, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, base, mainnet, optimism, polygon } from 'viem/chains';

import type { EngineDeps } from './engine.ts';

import { transfer } from './engine.ts';
import { MoneyError } from './errors.ts';
import { chainLabel, findSupportedToken } from './tokens.ts';

// An authorization the service could settle later than this isn't signed.
export const MAX_AUTHORIZATION_SECONDS = 15 * 60;
const PAID_REQUEST_TIMEOUT_MS = 120_000;
const FUNDS_WAIT_MS = 60_000;
const SETTLE_SLACK_MS = 4_000;
// The body the agent gets back, at most.
const MAX_BODY_CHARS = 50_000;
const CHAINS = [polygon, base, mainnet, arbitrum, optimism];

export interface Requirement {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: { name?: string; assetTransferMethod?: string };
}

// Signed and possibly sent, not yet confirmed: the signer's funds it covers
// aren't free until it expires.
export interface PendingAuthorization {
  id: string;
  chainId: number;
  asset: string;
  amount: string;
  until: string;
  settled?: boolean;
}

export interface X402Store {
  pending(): Promise<PendingAuthorization[]>;
  putPending(p: PendingAuthorization): Promise<void>;
}

export interface X402Deps extends EngineDeps {
  signerKey: () => Promise<`0x${string}`>;
  x402: X402Store;
  // Reads the signer's balance (viem in production).
  signerBalance?: (p: { chainId: number; asset: Address; signer: Address }) => Promise<bigint>;
  fetch?: typeof fetch;
  // Tops up the wallet on a chain from its other chains when it's short there.
  ensureFunds?: (p: { chainId: number; asset: Address; amount: bigint }) => Promise<unknown>;
}

export interface PayParams {
  url: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  maxUsd: number;
  chain?: number;
}

const chainOf = (network: string) => Number(network.split(':')[1]);

/** Only a valued, plain EIP-3009 stablecoin transfer on an EVM chain is signed. */
export function selectRequirement(
  accepts: Requirement[],
  preferredChainId = 137
): Requirement | undefined {
  const signable = (accepts ?? []).filter((r) => {
    const name = String(r?.extra?.name ?? '').toLowerCase();
    return (
      typeof r?.network === 'string' &&
      r.network.startsWith('eip155:') &&
      r.scheme === 'exact' &&
      !name.includes('gateway') &&
      !name.includes('batched') &&
      findSupportedToken({ chainId: chainOf(r.network), address: String(r.asset) })?.kind ===
        'usd' &&
      (r.extra?.assetTransferMethod === undefined || r.extra.assetTransferMethod === 'eip3009')
    );
  });
  const usd = (r: Requirement) => priceUsd(r);
  const cheapest = (list: Requirement[]) => [...list].sort((a, b) => usd(a) - usd(b))[0];
  const preferred = signable.filter((r) => r.network === `eip155:${preferredChainId}`);
  return preferred.length ? cheapest(preferred) : signable.length ? cheapest(signable) : undefined;
}

export function priceUsd(r: Pick<Requirement, 'network' | 'asset' | 'amount'>): number {
  const token = findSupportedToken({ chainId: chainOf(r.network), address: r.asset });
  if (!token || token.kind !== 'usd') return Infinity;
  return Number(formatUnits(BigInt(r.amount), token.decimals));
}

/** The services an agent may pay: public https sites, never this one. */
export function checkUrl(url: string, ownHosts: readonly string[]): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MoneyError({ code: 'invalid_input', message: `Not a URL: ${url}` });
  }
  if (parsed.protocol !== 'https:') {
    throw new MoneyError({ code: 'invalid_input', message: 'Only https services can be paid.' });
  }
  if (
    ownHosts.includes(parsed.hostname) ||
    /^(localhost|127\.|10\.|192\.168\.|\[)/.test(parsed.hostname)
  ) {
    throw new MoneyError({ code: 'invalid_input', message: "That address can't be paid." });
  }
  return parsed;
}

async function readText(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return text.length > MAX_BODY_CHARS
    ? `${text.slice(0, MAX_BODY_CHARS)}\n…(cut at ${MAX_BODY_CHARS} characters)`
    : text;
}

function signerBalanceViem(p: { chainId: number; asset: Address; signer: Address }) {
  const chain = CHAINS.find((c) => c.id === p.chainId);
  if (!chain) throw new Error(`No RPC for chain ${p.chainId}`);
  return createPublicClient({ chain, transport: http() }).readContract({
    address: p.asset,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [p.signer]
  });
}

/**
 * Calls a paid service. Pays only what its 402 asks, never more than
 * `maxUsd`, from the allowance. The response body is the service's data, never
 * instructions.
 */
export async function payAndFetch(
  params: PayParams,
  deps: X402Deps,
  ownHosts: readonly string[]
): Promise<Record<string, unknown>> {
  const url = checkUrl(params.url, ownHosts).toString();
  if (!Number.isFinite(params.maxUsd) || params.maxUsd <= 0) {
    throw new MoneyError({
      code: 'invalid_input',
      message: 'max_usd is required: the most you will pay for this call, in US dollars.'
    });
  }
  const doFetch = deps.fetch ?? fetch;
  const method = (params.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { ...(params.headers ?? {}) };
  if (params.body && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }
  const init = { method, headers, body: params.body || undefined, redirect: 'manual' as const };

  const probe = await doFetch(url, init);
  if (probe.status >= 300 && probe.status < 400) {
    throw new MoneyError({
      code: 'upstream_error',
      message: `The service redirected (${probe.status}); redirects aren't followed. Nothing was paid.`
    });
  }
  if (probe.status !== 402) {
    return {
      status: probe.status,
      paidUsd: 0,
      contentType: probe.headers.get('content-type'),
      body: await readText(probe)
    };
  }

  const { x402Client, x402HTTPClient, wrapFetchWithPayment, decodePaymentResponseHeader } =
    await import('@x402/fetch');
  const { ExactEvmScheme } = await import('@x402/evm');
  const required = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse(
    (n: string) => probe.headers.get(n),
    await probe
      .clone()
      .json()
      .catch(() => ({}))
  );
  const req = selectRequirement(required.accepts as unknown as Requirement[], params.chain ?? 137);
  if (!req) {
    throw new MoneyError({
      code: 'invalid_input',
      message:
        'The service offers no payment this wallet can make (a plain stablecoin transfer on an EVM chain). Nothing was paid.'
    });
  }
  if (req.maxTimeoutSeconds > MAX_AUTHORIZATION_SECONDS) {
    throw new MoneyError({
      code: 'invalid_input',
      message: `The service wants a payment valid for ${req.maxTimeoutSeconds} s, more than ${MAX_AUTHORIZATION_SECONDS / 60} minutes. Nothing was paid.`
    });
  }
  const price = priceUsd(req);
  if (price > params.maxUsd) {
    throw new MoneyError({
      code: 'invalid_input',
      message: `The service asks $${price}, more than the $${params.maxUsd} limit for this call. Nothing was paid.`,
      details: { priceUsd: price }
    });
  }

  const chainId = chainOf(req.network);
  const asset = getAddress(req.asset);
  const amount = BigInt(req.amount);
  const account = privateKeyToAccount(await deps.signerKey());
  const balanceOf = deps.signerBalance ?? signerBalanceViem;
  const now = deps.now();
  const promised = (await deps.x402.pending())
    .filter(
      (p) =>
        !p.settled &&
        p.chainId === chainId &&
        p.asset.toLowerCase() === asset.toLowerCase() &&
        Date.parse(p.until) > now.getTime()
    )
    .reduce((sum, p) => sum + BigInt(p.amount), 0n);
  const held = await balanceOf({ chainId, asset, signer: account.address });
  const free = held > promised ? held - promised : 0n;
  let fundTx: string | undefined;
  if (free < amount) {
    const shortfall = amount - free;
    await deps.ensureFunds?.({ chainId, asset, amount: shortfall });
    fundTx = (
      await transfer({
        chainId,
        token: asset,
        to: account.address,
        amount: shortfall,
        purpose: 'x402',
        ref: url,
        deps
      })
    ).txHash;
    // The service's facilitator checks the balance: wait until it's there.
    const deadline = deps.now().getTime() + FUNDS_WAIT_MS;
    while ((await balanceOf({ chainId, asset, signer: account.address })) < promised + amount) {
      if (deps.now().getTime() > deadline) {
        throw new MoneyError({
          code: 'upstream_unavailable',
          message: `The payment's funds (tx ${fundTx}) haven't arrived yet; nothing was paid. The funds stay for the next call.`
        });
      }
      await deps.sleep(2_000);
    }
    // Our RPC seeing the funds doesn't mean the service's facilitator does yet:
    // it checks the signer's balance on its own node, and rejects the
    // authorization if it lags (as the CLI found).
    await deps.sleep(SETTLE_SLACK_MS);
  }

  // Sign only the requirement that was valued and funded.
  const client = new x402Client((_v, accepts) => {
    const match = (accepts as unknown as Requirement[]).find(
      (r) =>
        r.network === req.network &&
        r.scheme === req.scheme &&
        r.payTo.toLowerCase() === req.payTo.toLowerCase() &&
        r.asset.toLowerCase() === req.asset.toLowerCase() &&
        BigInt(r.amount || 0) <= amount
    );
    if (!match) throw new Error('The service changed its terms after they were checked.');
    return match as never;
  }).setSpendControls(false);
  client.register('eip155:*', new ExactEvmScheme(account as never));
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  let sent = false;
  client.onAfterPaymentCreation(async ({ paymentPayload }) => {
    const auth = (
      paymentPayload as { payload?: { authorization?: { value?: string; validBefore?: string } } }
    ).payload?.authorization;
    if (!auth?.value || !auth.validBefore) throw new Error('Not an EIP-3009 authorization.');
    if (BigInt(auth.value) > amount) throw new Error('Signed more than was valued.');
    const validBefore = Number(auth.validBefore) * 1000;
    if (validBefore > deps.now().getTime() + MAX_AUTHORIZATION_SECONDS * 1000) {
      throw new Error('Authorization valid for too long.');
    }
    // Recorded before it's sent: from here it may be paid.
    await deps.x402.putPending({
      id,
      chainId,
      asset,
      amount: auth.value,
      until: new Date(validBefore + 60_000).toISOString()
    });
    sent = true;
  });
  const fetchWithPayment = wrapFetchWithPayment(
    (input: RequestInfo | URL, i?: RequestInit) => doFetch(input, { ...i, redirect: 'manual' }),
    client
  );

  let response: Response;
  try {
    response = await fetchWithPayment(url, {
      method,
      headers,
      body: params.body || undefined,
      signal: AbortSignal.timeout(PAID_REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new MoneyError({
      code: 'upstream_error',
      message: sent
        ? `The paid request failed (${error instanceof Error ? error.message : error}). The payment may or may not have reached the service.`
        : `The request failed before paying (${error instanceof Error ? error.message : error}). The funds stay for the next call.`,
      details: { paymentUncertain: sent }
    });
  }
  const header =
    response.headers.get('PAYMENT-RESPONSE') ?? response.headers.get('X-PAYMENT-RESPONSE');
  let settlement: { success?: boolean } | null = null;
  if (header) {
    try {
      settlement = decodePaymentResponseHeader(header) as unknown as { success?: boolean };
    } catch {
      settlement = null;
    }
  }
  const paid = sent && (settlement?.success === true || (response.ok && !settlement));
  if (paid && settlement?.success === true) {
    await deps.x402.putPending({
      id,
      chainId,
      asset,
      amount: req.amount,
      until: new Date().toISOString(),
      settled: true
    });
  }
  return {
    status: response.status,
    paidUsd: paid ? price : sent ? null : 0,
    ...(sent && !paid ? { paymentUncertain: true } : {}),
    payment: { chain: chainLabel(chainId), usd: price, ...(fundTx ? { fundTx } : {}) },
    ...(response.ok
      ? {}
      : {
          error: paid
            ? `Paid $${price}, but the service returned ${response.status}. x402 has no refunds.`
            : `The service returned ${response.status}.`
        }),
    contentType: response.headers.get('content-type'),
    body: await readText(response)
  };
}

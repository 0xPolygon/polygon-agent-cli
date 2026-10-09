// Backs up the Polymarket trading key inside the user's OMS account, and signs with it
// through OMS when the local copy is gone. Every switch of the active OMS wallet is undone
// in a finally block so a session is never left on the imported key.

import type { Signer } from '@polymarket/client';

import { privateKeyToAccount } from 'viem/accounts';

import type { OMSWalletClient } from '@polygonlabs/oms-wallet';

import { findNetworkById } from '@polygonlabs/oms-wallet';

import { CliError } from '../errors.ts';

export const TRADING_KEY_REFERENCE = 'polymarket-trading-key';

export type OmsWalletLike = Pick<
  OMSWalletClient,
  'listWallets' | 'useWallet' | 'importWallet' | 'signTypedData' | 'signMessage' | 'walletAddress'
>;

const POLYGON_CHAIN_ID = 137;

const sameAddress = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

export async function selectMainWallet(
  w: OmsWalletLike,
  opts: { expectedAddress?: string }
): Promise<{ id: string; address: string }> {
  const wallets = await w.listWallets();
  const main = opts.expectedAddress
    ? wallets.find((x) => sameAddress(x.address, opts.expectedAddress))
    : wallets.find((x) => x.keyOrigin !== 'imported');
  if (!main) {
    throw new CliError({
      code: 'not_connected',
      message: opts.expectedAddress
        ? `No OMS wallet with address ${opts.expectedAddress} on this account`
        : 'No main OMS wallet found on this account',
      hint: 'Sign in again with: wallet login'
    });
  }
  if (!sameAddress(w.walletAddress, main.address)) {
    await w.useWallet({ walletId: main.id });
  }
  return { id: main.id, address: main.address };
}

export async function withActiveWallet<T>(
  w: OmsWalletLike,
  walletId: string,
  fn: () => Promise<T>
): Promise<T> {
  const wallets = await w.listWallets();
  const target = wallets.find((x) => x.id === walletId);
  if (target && sameAddress(w.walletAddress, target.address)) return fn();
  const previous = wallets.find((x) => sameAddress(x.address, w.walletAddress));
  await w.useWallet({ walletId });
  try {
    return await fn();
  } finally {
    if (previous) await w.useWallet({ walletId: previous.id });
  }
}

export async function findTradingKeyWallet(
  w: OmsWalletLike,
  address?: string
): Promise<{ id: string; address: string } | null> {
  const wallets = await w.listWallets();
  if (address) {
    const byAddress = wallets.find((x) => sameAddress(x.address, address));
    if (byAddress) return { id: byAddress.id, address: byAddress.address };
  }
  const byRef = wallets.find(
    (x) =>
      x.keyOrigin === 'imported' &&
      x.reference === TRADING_KEY_REFERENCE &&
      (!address || sameAddress(x.address, address))
  );
  return byRef ? { id: byRef.id, address: byRef.address } : null;
}

export async function backupTradingKey(
  w: OmsWalletLike,
  privateKey: `0x${string}`
): Promise<{ omsWalletId: string; address: string; imported: boolean }> {
  const address = privateKeyToAccount(privateKey).address;
  const wallets = await w.listWallets();
  const existing = wallets.find((x) => sameAddress(x.address, address));
  if (existing) return { omsWalletId: existing.id, address, imported: false };

  const previous = wallets.find((x) => sameAddress(x.address, w.walletAddress));
  let result: Awaited<ReturnType<OmsWalletLike['importWallet']>>;
  try {
    result = await w.importWallet({
      type: 'ethereum',
      privateKey,
      reference: TRADING_KEY_REFERENCE
    });
  } finally {
    if (previous && !sameAddress(w.walletAddress, previous.address)) {
      await w.useWallet({ walletId: previous.id });
    }
  }
  if (!sameAddress(result.wallet.address, address)) {
    throw new CliError({
      code: 'upstream_error',
      message: 'OMS imported a wallet whose address does not match the trading key',
      details: { expected: address, received: result.wallet.address }
    });
  }
  return { omsWalletId: result.wallet.id, address, imported: true };
}

const DOMAIN_FIELD_TYPES = [
  ['name', 'string'],
  ['version', 'string'],
  ['chainId', 'uint256'],
  ['verifyingContract', 'address'],
  ['salt', 'bytes32']
] as const;

export function omsSigner(w: OmsWalletLike, target: { walletId: string; address: string }): Signer {
  const network = () => {
    const n = findNetworkById(POLYGON_CHAIN_ID);
    if (!n) {
      throw new CliError({
        code: 'upstream_error',
        message: 'Polygon network is unavailable in OMS'
      });
    }
    return n;
  };
  return {
    getAddress: async () => target.address as Awaited<ReturnType<Signer['getAddress']>>,
    signTypedData: (payload) => {
      const domain = payload.domain as Record<string, unknown>;
      const eip712Domain = DOMAIN_FIELD_TYPES.filter(([k]) => domain[k] !== undefined).map(
        ([name, type]) => ({ name, type })
      );
      const typedData = {
        domain: payload.domain,
        message: payload.message,
        primaryType: payload.primaryType,
        types: { ...payload.types, EIP712Domain: eip712Domain }
      };
      return withActiveWallet(w, target.walletId, () =>
        w.signTypedData({ network: network(), typedData })
      ) as Promise<never>;
    },
    signMessage: (message) =>
      withActiveWallet(w, target.walletId, () =>
        w.signMessage({ network: network(), message })
      ) as Promise<never>,
    sendTransaction: async () => {
      throw new CliError({
        code: 'invalid_input',
        message: 'The OMS-backed Polymarket signer is gasless only and cannot send transactions'
      });
    }
  };
}

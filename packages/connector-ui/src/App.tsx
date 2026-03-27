import { Wallet, ExternalLink, ArrowRight, AlertCircle } from 'lucide-react';

import './App.css';

import { Hex, Signature } from 'ox';
import { useEffect, useMemo, useState } from 'react';

import type { SessionPayload } from '@polygonlabs/agent-shared';

import {
  DappClient,
  TransportMode,
  WebStorage,
  jsonReplacers,
  Utils,
  Permission
} from '@0xsequence/dapp-client';
import { encryptSession } from '@polygonlabs/agent-shared';

import { CodeDisplay } from './components/CodeDisplay.js';
import { dappOrigin, projectAccessKey, walletUrl, relayerUrl, nodesUrl } from './config';
import { resolveChainId, resolveNetwork } from './indexer';
import { resolveErc20Symbol } from './tokenDirectory';

async function deleteIndexedDb(dbName: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(dbName);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

async function resetLocalSessionStateForNewRid(rid: string): Promise<boolean> {
  if (!rid) return false;
  const key = 'moltbot.lastRid';
  const lastRid = window.localStorage.getItem(key);
  if (lastRid === rid) return false;

  window.localStorage.setItem(key, rid);

  // dapp-client uses sessionStorage for pending redirect state
  try {
    sessionStorage.clear();
  } catch {}

  // and IndexedDB for sessions
  await deleteIndexedDb('SequenceDappStorage');

  // also clear local storage keys we might set (keep the rid marker)
  for (const k of Object.keys(localStorage)) {
    if (k === key) continue;
    // keep vite keys etc? (none expected)
  }

  return true;
}

function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const rid = params.get('rid') || '';
  const walletName = params.get('wallet') || '';

  const chainId = useMemo(() => resolveChainId(params), [params]);
  const network = useMemo(() => resolveNetwork(chainId), [chainId]);

  const [error, setError] = useState<string>('');
  const [walletAddress, setWalletAddress] = useState<string>('');
  const [cliPkHex, setCliPkHex] = useState<string>('');
  const [sessionCode, setSessionCode] = useState<string>('');

  const [feeTokens, setFeeTokens] = useState<any | null>(null);

  // Reset local session state every time a new rid is opened.
  useEffect(() => {
    void (async () => {
      const didReset = await resetLocalSessionStateForNewRid(rid);
      if (didReset) window.location.reload();
    })();
  }, [rid]);

  // Fetch CLI public key from relay on mount
  useEffect(() => {
    if (!rid) return;
    if (!/^[a-z0-9]{8}$/.test(rid)) {
      setError('Invalid session link. Please generate a new connection URL.');
      return;
    }
    fetch(`/api/relay/request/${rid}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Relay returned ${r.status}`);
        return r.json() as Promise<{ cli_pk_hex: string }>;
      })
      .then(({ cli_pk_hex }) => {
        if (!/^[0-9a-f]{64}$/.test(cli_pk_hex)) {
          throw new Error('Invalid cli_pk_hex format received from relay');
        }
        setCliPkHex(cli_pk_hex);
      })
      .catch((e: any) => setError(`Failed to load session key: ${e?.message || String(e)}`));
  }, [rid]);

  const dappClient = useMemo(() => {
    return new DappClient(walletUrl, dappOrigin, projectAccessKey, {
      transportMode: TransportMode.POPUP,
      relayerUrl,
      nodesUrl,
      // default WebStorage (IndexedDB) is fine for browser
      sequenceStorage: new WebStorage()
    });
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await dappClient.initialize();
        // Prefetch fee tokens so the actual Connect click can open the popup synchronously.
        try {
          setFeeTokens(await dappClient.getFeeTokens(chainId));
        } catch {
          setFeeTokens(null);
        }
      } catch (e: any) {
        setError(e?.message || String(e));
      }
    })();
  }, [dappClient]);

  const connect = async () => {
    // feeTokens are prefetched to keep UX snappy.
    void feeTokens;
    setError('');
    setSessionCode('');

    if (!rid || !walletName) {
      setError('Invalid link. Missing rid or wallet.');
      return;
    }
    if (!cliPkHex) {
      setError('Session key not loaded yet. Please wait or refresh.');
      return;
    }

    try {
      const VALUE_FORWARDER = '0xABAAd93EeE2a569cF0632f39B10A9f5D734777ca';
      // Resolve ERC20 addresses per-chain via Sequence Token Directory
      const USDC = (await resolveErc20Symbol(chainId, 'USDC'))?.address;
      const USDT = (await resolveErc20Symbol(chainId, 'USDT'))?.address;

      // Base explicit session permissions:
      // - ValueForwarder: where we route native token sends (open-ended recipient).
      //
      // NOTE: demo-dapp-v3 does NOT include an explicit permission for the Sessions module.
      // The Sessions module's internal `incrementUsageLimit` call (when present) is handled by the session system
      // itself and should not require an explicit Permission{target,rules} entry.
      const basePermissions: any[] = [{ target: VALUE_FORWARDER, rules: [] }];

      const params = new URLSearchParams(window.location.search);

      // Optional: one-off ERC20 permission scoped by link params (kept for backwards-compat).
      const erc20 = params.get('erc20');
      const erc20To = params.get('erc20To');
      const erc20Amount = params.get('erc20Amount');

      const oneOffErc20Permissions: any[] =
        erc20 && erc20To && erc20Amount
          ? (() => {
              const tokenAddr = erc20.toLowerCase() === 'usdc' ? USDC : erc20;
              const decimals = erc20.toLowerCase() === 'usdc' ? 6 : 18;

              const [i, fRaw = ''] = String(erc20Amount).split('.');
              const f = (fRaw + '0'.repeat(decimals)).slice(0, decimals);
              const valueLimit = BigInt(i || '0') * 10n ** BigInt(decimals) + BigInt(f || '0');

              return [
                Utils.PermissionBuilder.for(tokenAddr as any)
                  .forFunction('function transfer(address to, uint256 value)')
                  .withUintNParam(
                    'value',
                    valueLimit,
                    256,
                    Permission.ParameterOperation.LESS_THAN_OR_EQUAL,
                    true
                  )
                  .withAddressParam(
                    'to',
                    erc20To as any,
                    Permission.ParameterOperation.EQUAL,
                    false
                  )
                  .build()
              ];
            })()
          : [];

      // Open-ended per-token limits (no fixed recipient), so we can operate without per-target sessions.
      // Query params:
      // - usdcLimit (e.g. 50)
      // - usdtLimit (e.g. 50)
      // - nativeLimit (e.g. 1.5)  (back-compat: polLimit)
      const usdcLimit = params.get('usdcLimit');
      const usdtLimit = params.get('usdtLimit');
      const nativeLimit = params.get('nativeLimit') || params.get('polLimit');
      const tokenLimitsRaw = params.get('tokenLimits');

      // Bridged USDC (USDC.e) on Polygon — always include alongside native USDC to avoid
      // troubleshooting when the relayer selects a different USDC variant for fee payment.
      const USDC_E_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

      const openTokenPermissions: any[] = [];

      // Generic ERC20 limits via token-directory: tokenLimits=USDC:50,WETH:0.1
      const dynamicTokenPermissions: any[] = [];
      if (tokenLimitsRaw) {
        const parts = tokenLimitsRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        for (const p of parts) {
          const [sym, amt] = p.split(':').map((x) => (x || '').trim());
          if (!sym || !amt) throw new Error(`Invalid tokenLimits entry: ${p}`);
          const td = await resolveErc20Symbol(chainId, sym);
          if (!td) throw new Error(`${sym} not found for this chain in token-directory`);
          const decimals = td.decimals;
          const valueLimit = BigInt(Math.floor(parseFloat(amt) * 10 ** decimals));
          dynamicTokenPermissions.push(
            Utils.PermissionBuilder.for(td.address as any)
              .forFunction('function transfer(address to, uint256 value)')
              .withUintNParam(
                'value',
                valueLimit,
                256,
                Permission.ParameterOperation.LESS_THAN_OR_EQUAL,
                true
              )
              .build()
          );
        }
      }
      if (usdcLimit) {
        if (!USDC) throw new Error('USDC not found for this chain in token-directory');
        const valueLimit = BigInt(parseFloat(usdcLimit) * 1e6);
        // Native USDC
        openTokenPermissions.push(
          Utils.PermissionBuilder.for(USDC as any)
            .forFunction('function transfer(address to, uint256 value)')
            .withUintNParam(
              'value',
              valueLimit,
              256,
              Permission.ParameterOperation.LESS_THAN_OR_EQUAL,
              true
            )
            .build()
        );
        // Bridged USDC (USDC.e) on Polygon — same limit, covers relayer fee variant
        if (chainId === 137) {
          openTokenPermissions.push(
            Utils.PermissionBuilder.for(USDC_E_POLYGON as any)
              .forFunction('function transfer(address to, uint256 value)')
              .withUintNParam(
                'value',
                valueLimit,
                256,
                Permission.ParameterOperation.LESS_THAN_OR_EQUAL,
                true
              )
              .build()
          );
        }
      }
      if (usdtLimit) {
        if (!USDT) throw new Error('USDT not found for this chain in token-directory');
        const valueLimit = BigInt(parseFloat(usdtLimit) * 1e6);
        openTokenPermissions.push(
          Utils.PermissionBuilder.for(USDT as any)
            .forFunction('function transfer(address to, uint256 value)')
            .withUintNParam(
              'value',
              valueLimit,
              256,
              Permission.ParameterOperation.LESS_THAN_OR_EQUAL,
              true
            )
            .build()
        );
      }

      // Fee-option permissions (pre-approvals) so the session can pay fees with ERC20s.
      // IMPORTANT: We do NOT add a blanket permission for paymentAddress itself.
      // Instead, we scope permissions to ERC20.transfer(to=paymentAddress, value<=limit) per fee token.
      // Note: we include these regardless of isFeeRequired — wallets funded only with ERC20 tokens
      // always need these, and including them when not needed is harmless.
      const nativeFeePermission: any[] = [];

      const feePermissions: any[] =
        (feeTokens as any)?.paymentAddress && Array.isArray((feeTokens as any)?.tokens)
          ? ((feeTokens as any).tokens as any[])
              .filter((t) => !!t?.contractAddress)
              .map((token: any) => {
                const decimals = typeof token.decimals === 'number' ? token.decimals : 6;
                const valueLimit =
                  decimals === 18
                    ? 100000000000000000n // 0.1 * 1e18
                    : 50n * 10n ** BigInt(decimals);

                return Utils.PermissionBuilder.for(token.contractAddress as any)
                  .forFunction('function transfer(address to, uint256 value)')
                  .withUintNParam(
                    'value',
                    valueLimit,
                    256,
                    Permission.ParameterOperation.LESS_THAN_OR_EQUAL,
                    true
                  )
                  .withAddressParam(
                    'to',
                    (feeTokens as any).paymentAddress as any,
                    Permission.ParameterOperation.EQUAL,
                    false
                  )
                  .build();
              })
          : [];

      // Contract whitelist (--contract 0x... repeatable): allow calls to specified contracts (e.g. ERC-8004 registries).
      // Format: contracts=0xaddr1,0xaddr2
      const contractsRaw = params.get('contracts');
      const contractWhitelistPermissions: any[] = [];
      if (contractsRaw) {
        const addrs = contractsRaw
          .split(',')
          .map((s) => (s || '').trim())
          .filter(Boolean);
        for (const addr of addrs) {
          if (/^0x[a-fA-F0-9]{40}$/.test(addr)) {
            contractWhitelistPermissions.push({ target: addr as any, rules: [] });
          }
        }
      }

      const polValueLimit = nativeLimit
        ? BigInt(Math.floor(parseFloat(nativeLimit) * 1e18))
        : 2000000000000000000n;

      const sessionConfig = {
        chainId,
        // Native spend limit (chain native token)
        valueLimit: polValueLimit,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 183),
        permissions: [
          ...basePermissions,
          ...contractWhitelistPermissions,
          ...oneOffErc20Permissions,
          ...openTokenPermissions,
          ...dynamicTokenPermissions,
          ...nativeFeePermission,
          ...feePermissions
        ]
      };

      // Connect will open the wallet UI (popup).
      await dappClient.connect(chainId, sessionConfig as any, { includeImplicitSession: true });

      const addr = await dappClient.getWalletAddress();
      if (!addr) throw new Error('Wallet address not available after connect');
      setWalletAddress(addr);

      // Read explicit + implicit session material from dapp-client storage.
      const storage = (dappClient as any).sequenceStorage;

      const sessions = await storage.getExplicitSessions();
      const explicit = (sessions || []).find(
        (s: any) =>
          String(s.chainId) === String(chainId) &&
          String(s.walletAddress).toLowerCase() === addr.toLowerCase()
      );
      if (!explicit?.pk) throw new Error('Could not locate explicit session pk after connect');

      const implicit = await storage.getImplicitSession();
      if (!implicit?.pk || !implicit?.attestation || !implicit?.identitySignature) {
        throw new Error('Could not locate implicit session material after connect');
      }

      // identitySignature must be a serialized 65-byte signature hex string.
      // In some dapp-client/ox paths, this can be an object (e.g. { r, s, yParity }) or Uint8Array.
      const sigAny: any = implicit.identitySignature;
      let identitySignature: string;
      try {
        if (typeof sigAny === 'string') {
          identitySignature = sigAny;
        } else if (sigAny instanceof Uint8Array) {
          identitySignature = Hex.from(sigAny);
        } else if (sigAny && typeof sigAny === 'object') {
          if (typeof sigAny.data === 'string') {
            // jsonReplacers may have wrapped a Uint8Array as { _isUint8Array: true, data: '0x..' }
            identitySignature = sigAny.data;
          } else {
            identitySignature = Signature.toHex(sigAny);
          }
        } else {
          throw new Error('Unsupported identitySignature type');
        }
      } catch (e: any) {
        throw new Error(`Could not serialize identitySignature: ${e?.message || String(e)}`);
      }

      // Export material needed for headless v3 signing:
      // - explicit session pk
      // - explicit session config used during connect (permissions/valueLimit/deadline/chainId)
      // - derived sessionAddress
      // dapp-client storage only persists {pk,walletAddress,chainId,...}, not the permissions config.
      const { Secp256k1, Address: OxAddress, Hex: OxHex } = await import('ox');
      const sessionAddress = OxAddress.fromPublicKey(
        Secp256k1.getPublicKey({ privateKey: OxHex.toBytes(explicit.pk) })
      );

      // Build SessionPayload for v2 relay protocol
      const sessionPayloadData: SessionPayload = {
        version: 1,
        wallet_address: addr,
        chain_id: chainId,
        session_private_key: explicit.pk,
        session_address: sessionAddress,
        permissions: {
          native_limit: polValueLimit.toString(),
          erc20_limits: [],
          contract_calls: []
        },
        expiry: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 183,
        ecosystem_wallet_url: walletUrl,
        dapp_origin: dappOrigin,
        project_access_key: projectAccessKey,
        session_config: JSON.stringify(sessionConfig, jsonReplacers),
        implicit_session: {
          pk:
            typeof implicit.pk === 'string'
              ? implicit.pk
              : JSON.stringify(implicit.pk, jsonReplacers),
          attestation:
            typeof implicit.attestation === 'string'
              ? implicit.attestation
              : JSON.stringify(implicit.attestation, jsonReplacers),
          identity_sig: identitySignature,
          guard: (implicit as any).guard
            ? JSON.stringify((implicit as any).guard, jsonReplacers)
            : undefined,
          login_method: (implicit as any).loginMethod ?? undefined,
          user_email: (implicit as any).userEmail ?? undefined
        }
      };

      // Encrypt and post to relay
      const { encrypted, code } = encryptSession(sessionPayloadData, cliPkHex, rid);
      const relayRes = await fetch(`/api/relay/session/${rid}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(encrypted)
      });
      if (!relayRes.ok) throw new Error(`Failed to deliver session to relay (${relayRes.status})`);

      setSessionCode(code);
    } catch (e: any) {
      console.error(e);
      setError(e?.message || String(e));
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 sm:p-8">
      <div className="w-full max-w-lg mx-auto animate-scale-in">
        {/* Main Card */}
        <div className="card-glow rounded-2xl bg-surface/80 backdrop-blur-xl border border-border shadow-2xl shadow-black/40 overflow-hidden">
          {/* Brand Header */}
          <div className="px-6 pt-6 pb-5 border-b border-border">
            <div className="flex items-center gap-3">
              <div className="relative">
                <div className="w-10 h-10 rounded-xl overflow-hidden shadow-lg shadow-poly/20">
                  <svg
                    width="40"
                    height="40"
                    viewBox="0 0 360 360"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <rect width="360" height="360" rx="180" fill="#6C00F6" />
                    <path
                      d="M218.804 99.5819L168.572 128.432V218.473L140.856 234.539L112.97 218.46V186.313L140.856 170.39L158.786 180.788V154.779L140.699 144.511L90.4795 173.687V231.399L140.869 260.418L191.088 231.399V141.371L218.974 125.291L246.846 141.371V173.374L218.974 189.597L200.887 179.107V204.986L218.804 215.319L269.519 186.47V128.432L218.804 99.5819Z"
                      fill="white"
                    />
                  </svg>
                </div>
                <div className="absolute inset-0 rounded-xl animate-pulse-glow" />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-text-primary tracking-tight">
                  Polygon Agent Kit
                </h1>
                <p className="text-sm text-text-secondary mt-0.5">
                  {network.title} &middot; Wallet Session
                </p>
              </div>
            </div>
          </div>

          {/* ======== PRE-CONNECT STATE ======== */}
          {!walletAddress && (
            <div className="p-6 space-y-5 animate-fade-in">
              {/* Instructions */}
              <p className="text-sm text-text-secondary leading-relaxed">
                Click connect and approve the wallet session. You&apos;ll then see a 6-digit code to
                enter in your terminal.
              </p>

              {/* Connect Button */}
              <button
                className="btn-press w-full h-12 rounded-xl bg-gradient-to-r from-poly to-poly-light text-white font-semibold text-sm tracking-wide shadow-lg shadow-poly/25 hover:shadow-xl hover:shadow-poly/30 hover:brightness-110 transition-all duration-200 flex items-center justify-center gap-2 cursor-pointer border-0"
                onClick={connect}
              >
                <Wallet className="w-4 h-4" />
                Connect Wallet
                <ArrowRight className="w-4 h-4" />
              </button>

              {/* Error */}
              {error && (
                <div className="flex items-start gap-2 px-3.5 py-3 rounded-xl bg-error-glow border border-error/20 animate-slide-up">
                  <AlertCircle className="w-4 h-4 text-error shrink-0 mt-0.5" />
                  <p className="text-sm text-error">{error}</p>
                </div>
              )}
            </div>
          )}

          {/* ======== POST-CONNECT STATE ======== */}
          {walletAddress && !sessionCode && (
            <div className="p-6 space-y-5 animate-slide-up">
              {/* Wallet Address Badge */}
              <div>
                <label className="text-xs font-medium text-text-muted uppercase tracking-wider">
                  Connected Wallet
                </label>
                <div className="mt-2 flex items-center gap-2.5 px-3.5 py-3 rounded-xl bg-surface-elevated border border-border">
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-poly/30 to-poly-dark/20 border border-poly/20 flex items-center justify-center shrink-0">
                    <Wallet className="w-4 h-4 text-poly-light" />
                  </div>
                  <span className="text-sm text-text-primary font-mono truncate flex-1">
                    {walletAddress}
                  </span>
                  <a
                    href={`https://polygonscan.com/address/${walletAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-text-muted hover:text-poly-light transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>

              {/* Encrypting state */}
              <div className="flex items-center gap-3 px-3.5 py-3 rounded-xl bg-surface-elevated border border-border">
                <div
                  className="w-4 h-4 rounded-full border-2 border-poly border-t-transparent shrink-0"
                  style={{ animation: 'spin 0.8s linear infinite' }}
                />
                <p className="text-sm text-text-secondary">Encrypting session...</p>
              </div>

              {/* Error */}
              {error && (
                <div className="flex items-start gap-2 px-3.5 py-3 rounded-xl bg-error-glow border border-error/20 animate-slide-up">
                  <AlertCircle className="w-4 h-4 text-error shrink-0 mt-0.5" />
                  <p className="text-sm text-error">{error}</p>
                </div>
              )}
            </div>
          )}

          {/* ======== CODE DISPLAY STATE ======== */}
          {sessionCode && (
            <div className="p-6 animate-slide-up">
              <CodeDisplay
                code={sessionCode}
                walletAddress={walletAddress}
                walletName={walletName}
              />
            </div>
          )}

          {/* Footer */}
          <div className="px-6 py-3 border-t border-border flex items-center justify-center">
            <span className="text-xs text-text-muted">Powered by Polygon</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export { App };

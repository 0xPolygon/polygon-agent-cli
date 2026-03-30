import { Wallet, Copy, AlertCircle, Plus } from 'lucide-react';

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
import { FundingScreen } from './components/FundingScreen.js';
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
  try {
    sessionStorage.clear();
  } catch {}
  await deleteIndexedDb('SequenceDappStorage');
  return true;
}

// --- Static background: use-cases panel ---

const USE_CASES = [
  'DeFi automation',
  'Trading agent',
  'Prediction market agent',
  'Pay for APIs mid-task'
];

const SAMPLE_COMMAND = `$ Claude Read https://polygon.technology/SKILL.md and DCA $20 USDC into POL every Monday at 9am. If POL drops more than 10% in a day, double the buy. Execute autonomously, no confirmations needed.`;

function PolygonLogo() {
  return (
    <svg width="28" height="28" viewBox="0 0 360 360" fill="none">
      <rect width="360" height="360" rx="180" fill="#8247E5" />
      <path
        d="M218.804 99.5819L168.572 128.432V218.473L140.856 234.539L112.97 218.46V186.313L140.856 170.39L158.786 180.788V154.779L140.699 144.511L90.4795 173.687V231.399L140.869 260.418L191.088 231.399V141.371L218.974 125.291L246.846 141.371V173.374L218.974 189.597L200.887 179.107V204.986L218.804 215.319L269.519 186.47V128.432L218.804 99.5819Z"
        fill="white"
      />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M8 1l1.5 4.5L14 7l-4.5 1.5L8 13l-1.5-4.5L2 7l4.5-1.5L8 1z" fill="#8247e5" />
    </svg>
  );
}

// --- Main App ---

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
  const [showFunding, setShowFunding] = useState(false);
  const [feeTokens, setFeeTokens] = useState<any | null>(null);

  // Reset local session state on new rid
  useEffect(() => {
    void (async () => {
      const didReset = await resetLocalSessionStateForNewRid(rid);
      if (didReset) window.location.reload();
    })();
  }, [rid]);

  // Fetch CLI public key from relay
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

  // Poll relay status after code shown — auto-transition to funding when CLI retrieves payload
  useEffect(() => {
    if (!sessionCode || !rid || showFunding) return;
    let active = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/relay/status/${rid}`);
        if (res.status === 404 && active) {
          setShowFunding(true);
        }
      } catch {
        // network error — keep polling
      }
    };
    const id = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [sessionCode, rid, showFunding]);

  const dappClient = useMemo(() => {
    return new DappClient(walletUrl, dappOrigin, projectAccessKey, {
      transportMode: TransportMode.POPUP,
      relayerUrl,
      nodesUrl,
      sequenceStorage: new WebStorage()
    });
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await dappClient.initialize();
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
      const USDC = (await resolveErc20Symbol(chainId, 'USDC'))?.address;
      const USDT = (await resolveErc20Symbol(chainId, 'USDT'))?.address;
      const basePermissions: any[] = [{ target: VALUE_FORWARDER, rules: [] }];
      const searchParams = new URLSearchParams(window.location.search);
      const erc20 = searchParams.get('erc20');
      const erc20To = searchParams.get('erc20To');
      const erc20Amount = searchParams.get('erc20Amount');
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

      const usdcLimit = searchParams.get('usdcLimit');
      const usdtLimit = searchParams.get('usdtLimit');
      const nativeLimit = searchParams.get('nativeLimit') || searchParams.get('polLimit');
      const tokenLimitsRaw = searchParams.get('tokenLimits');
      const USDC_E_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
      const openTokenPermissions: any[] = [];
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
          dynamicTokenPermissions.push(
            Utils.PermissionBuilder.for(td.address as any)
              .forFunction('function transfer(address to, uint256 value)')
              .withUintNParam(
                'value',
                BigInt(Math.floor(parseFloat(amt) * 10 ** td.decimals)),
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
        openTokenPermissions.push(
          Utils.PermissionBuilder.for(USDT as any)
            .forFunction('function transfer(address to, uint256 value)')
            .withUintNParam(
              'value',
              BigInt(parseFloat(usdtLimit) * 1e6),
              256,
              Permission.ParameterOperation.LESS_THAN_OR_EQUAL,
              true
            )
            .build()
        );
      }
      const nativeFeePermission: any[] = [];
      const feePermissions: any[] =
        (feeTokens as any)?.paymentAddress && Array.isArray((feeTokens as any)?.tokens)
          ? ((feeTokens as any).tokens as any[])
              .filter((t) => !!t?.contractAddress)
              .map((token: any) => {
                const decimals = typeof token.decimals === 'number' ? token.decimals : 6;
                const valueLimit =
                  decimals === 18 ? 100000000000000000n : 50n * 10n ** BigInt(decimals);
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

      const contractsRaw = searchParams.get('contracts');
      const contractWhitelistPermissions: any[] = [];
      if (contractsRaw) {
        for (const addr of contractsRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)) {
          if (/^0x[a-fA-F0-9]{40}$/.test(addr))
            contractWhitelistPermissions.push({ target: addr as any, rules: [] });
        }
      }

      const polValueLimit = nativeLimit
        ? BigInt(Math.floor(parseFloat(nativeLimit) * 1e18))
        : 2000000000000000000n;
      const sessionConfig = {
        chainId,
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

      await dappClient.connect(chainId, sessionConfig as any, { includeImplicitSession: true });

      const addr = await dappClient.getWalletAddress();
      if (!addr) throw new Error('Wallet address not available after connect');
      setWalletAddress(addr);

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

      const sigAny: any = implicit.identitySignature;
      let identitySignature: string;
      if (typeof sigAny === 'string') {
        identitySignature = sigAny;
      } else if (sigAny instanceof Uint8Array) {
        identitySignature = Hex.from(sigAny);
      } else if (sigAny && typeof sigAny === 'object') {
        identitySignature = typeof sigAny.data === 'string' ? sigAny.data : Signature.toHex(sigAny);
      } else {
        throw new Error('Unsupported identitySignature type');
      }

      const { Secp256k1, Address: OxAddress, Hex: OxHex } = await import('ox');
      const sessionAddress = OxAddress.fromPublicKey(
        Secp256k1.getPublicKey({ privateKey: OxHex.toBytes(explicit.pk) })
      );

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

  const shortAddr = walletAddress
    ? `${walletAddress.slice(0, 6)}..${walletAddress.slice(-4)}`
    : null;

  return (
    <div className="min-h-screen bg-[#eeeef5]">
      {/* ── Top nav ── */}
      <nav className="bg-white border-b border-[#e5e5f0] px-6 py-3.5 flex items-center justify-between">
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <PolygonLogo />
          <span className="text-base font-semibold text-[#0f0f1a]">polygon</span>
          <span className="text-xs font-semibold bg-[#0f0f1a] text-white px-2 py-0.5 rounded-md">
            Agent
          </span>
        </div>

        {/* Right: wallet chip or connect button */}
        {walletAddress ? (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 bg-[#f3f4f8] rounded-full px-3 py-1.5 text-sm text-[#374151]">
              <div className="w-5 h-5 rounded-full bg-gradient-to-br from-[#8247e5] to-[#c084fc]" />
              <span className="font-mono text-sm">{shortAddr}</span>
            </div>
          </div>
        ) : (
          <button
            onClick={connect}
            className="btn-press flex items-center gap-2 bg-[#8247e5] hover:bg-[#7139d4] text-white text-sm font-semibold px-4 py-2 rounded-full transition-colors cursor-pointer border-0"
          >
            <Wallet className="w-4 h-4" />
            Connect wallet
          </button>
        )}
      </nav>

      {/* ── Main content ── */}
      <main className="max-w-4xl mx-auto px-6 py-8">
        {/* Balance + Add funds (only after connect) */}
        {walletAddress && (
          <div className="flex items-start justify-between mb-6 animate-fade-in">
            <div>
              <div className="text-5xl font-bold text-[#0f0f1a] mb-2">U$0.00</div>
              <div className="flex items-center gap-2 text-sm text-[#6b7280]">
                <div className="w-3.5 h-3.5 rounded-full bg-[#8247e5]" />
                <span className="font-mono">{shortAddr}</span>
                <span className="text-[#e5e5f0]">·</span>
                <span className="flex items-center gap-1 text-[#16a34a]">
                  <span className="w-2 h-2 rounded-full bg-[#16a34a] inline-block" />
                  Connected
                </span>
              </div>
            </div>
            <button
              onClick={() => setShowFunding(true)}
              className="btn-press flex items-center gap-2 bg-[#8247e5] hover:bg-[#7139d4] text-white font-semibold px-5 py-2.5 rounded-full transition-colors cursor-pointer border-0"
            >
              <Plus className="w-4 h-4" />
              Add funds
            </button>
          </div>
        )}

        {/* ── Pre-connect state: inline connect card ── */}
        {!walletAddress && (
          <div className="mb-6 animate-scale-in">
            <div className="bg-white rounded-2xl border border-[#e5e5f0] p-6 max-w-md mx-auto">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl overflow-hidden">
                  <PolygonLogo />
                </div>
                <div>
                  <div className="font-semibold text-[#0f0f1a]">Polygon Agent Kit</div>
                  <div className="text-sm text-[#6b7280]">{network.title} · Wallet Session</div>
                </div>
              </div>

              <p className="text-sm text-[#6b7280] mb-5 leading-relaxed">
                Connect your wallet to authorize an agent session. You'll receive a 6-digit code to
                enter in your terminal or agent.
              </p>

              <button
                onClick={connect}
                className="btn-press w-full h-12 rounded-xl bg-[#8247e5] hover:bg-[#7139d4] text-white font-semibold text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer border-0"
              >
                <Wallet className="w-4 h-4" />
                Connect Wallet
              </button>

              {error && (
                <div className="mt-4 flex items-start gap-2 px-3.5 py-3 rounded-xl bg-red-50 border border-red-100">
                  <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                  <p className="text-sm text-red-600">{error}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Post-connect: encrypting spinner ── */}
        {walletAddress && !sessionCode && (
          <div className="mb-6 animate-fade-in">
            <div className="bg-white rounded-2xl border border-[#e5e5f0] p-5 flex items-center gap-3">
              <div
                className="w-4 h-4 rounded-full border-2 border-[#8247e5] border-t-transparent shrink-0"
                style={{ animation: 'spin 0.8s linear infinite' }}
              />
              <p className="text-sm text-[#6b7280]">Encrypting session and sending to relay…</p>
            </div>
            {error && (
              <div className="mt-3 flex items-start gap-2 px-3.5 py-3 rounded-xl bg-red-50 border border-red-100">
                <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                <p className="text-sm text-red-600">{error}</p>
              </div>
            )}
          </div>
        )}

        {/* ── Code display ── */}
        {sessionCode && !showFunding && (
          <div className="mb-6">
            <CodeDisplay code={sessionCode} onContinue={() => setShowFunding(true)} />
          </div>
        )}

        {/* ── Funding screen ── */}
        {showFunding && (
          <div className="mb-6">
            <FundingScreen
              walletAddress={walletAddress}
              chainId={chainId}
              projectAccessKey={projectAccessKey}
              onSkip={() => {
                window.location.href = 'https://agent.polygon.technology';
              }}
            />
          </div>
        )}

        {/* ── Background: use cases + terminal (always visible) ── */}
        <div className="grid grid-cols-2 gap-0 bg-white rounded-2xl border border-[#e5e5f0] overflow-hidden mb-4">
          {/* Left: use cases */}
          <div className="p-5 border-r border-[#e5e5f0]">
            <div className="space-y-1">
              {USE_CASES.map((uc, i) => (
                <div
                  key={uc}
                  className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm ${
                    i === 0 ? 'bg-[#f3f4f8] text-[#0f0f1a] font-medium' : 'text-[#374151]'
                  }`}
                >
                  <SparkleIcon />
                  {uc}
                </div>
              ))}
            </div>
            <button className="mt-3 w-full flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl border border-[#e5e5f0] text-sm text-[#374151] bg-transparent cursor-pointer hover:bg-[#f9f9fc] transition-colors">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path
                  d="M7 17L17 7M17 7H7M17 7V17"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              See all usecases
            </button>
          </div>

          {/* Right: terminal */}
          <div className="p-5 flex flex-col">
            <pre className="text-xs leading-relaxed flex-1 text-[#374151] whitespace-pre-wrap font-mono">
              <span className="text-[#16a34a] font-semibold">$ Claude</span>
              {SAMPLE_COMMAND.slice(7)}
            </pre>
            <div className="mt-3 pt-3 border-t border-[#f0f0f5]">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-6 h-6 rounded-full bg-[#f3f4f8] flex items-center justify-center">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="#D97706">
                    <circle cx="12" cy="12" r="10" />
                  </svg>
                </div>
                <div className="w-6 h-6 rounded-full bg-[#f3f4f8] flex items-center justify-center">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="#10A37F">
                    <circle cx="12" cy="12" r="10" />
                  </svg>
                </div>
                <div className="w-6 h-6 rounded-full bg-[#f3f4f8] flex items-center justify-center">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="#4285F4">
                    <circle cx="12" cy="12" r="10" />
                  </svg>
                </div>
              </div>
              <button className="w-full flex items-center justify-center gap-2 border border-[#e5e5f0] rounded-xl py-2.5 text-sm text-[#374151] hover:bg-[#f9f9fc] transition-colors cursor-pointer bg-white">
                <Copy className="w-4 h-4" />
                Copy to your terminal
              </button>
            </div>
          </div>
        </div>

        {/* Learn more */}
        <h3 className="text-base font-semibold text-[#0f0f1a] mb-3">Learn more</h3>
        <div className="grid grid-cols-3 gap-3 mb-6">
          {[
            {
              title: 'Github',
              desc: 'Browse the source code, open issues, and contribute to the Polygon Agent CLI.'
            },
            {
              title: 'Developer tools Docs',
              desc: 'Full CLI reference, quickstart guide, and architecture docs to get your agent onchain fast.'
            },
            {
              title: 'Services list',
              desc: 'Explore the onchain services your agent can use: swaps, onramps, x402 payments, Polymarket, and more.'
            }
          ].map((card) => (
            <div key={card.title} className="bg-white rounded-xl border border-[#e5e5f0] p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-[#0f0f1a]">{card.title}</span>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  className="text-[#9ca3af]"
                >
                  <path
                    d="M7 17L17 7M17 7H7M17 7V17"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <p className="text-xs text-[#9ca3af] leading-relaxed">{card.desc}</p>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="text-center py-4 text-xs text-[#9ca3af]">Powered by Polygon</div>
      </main>
    </div>
  );
}

export { App };

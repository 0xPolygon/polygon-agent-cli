import type { ElementType } from 'react';

import './App.css';

import {
  Wallet,
  Copy,
  AlertCircle,
  Plus,
  Twitter,
  BarChart2,
  Target,
  ArrowLeftRight,
  TrendingUp
} from 'lucide-react';
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
import { resolveChainId, fetchTotalUsdBalance } from './indexer';
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

const SKILL_URL = 'https://agentconnect.polygon.technology/SKILL.md';

const AGENTS: {
  id: string;
  label: string;
  color: string;
  terminalPrefix: string;
  buildCommand: (display: string) => string;
}[] = [
  {
    id: 'claude',
    label: 'Claude',
    color: '#D97706',
    terminalPrefix: 'claude',
    buildCommand: (display) => `claude "Read ${SKILL_URL} and ${display}"`
  },
  {
    id: 'codex',
    label: 'Codex',
    color: '#10A37F',
    terminalPrefix: 'codex',
    buildCommand: (display) => `codex "Read ${SKILL_URL} and ${display}"`
  },
  {
    id: 'openclaw',
    label: 'Openclaw',
    color: '#8B5CF6',
    terminalPrefix: 'clawhub',
    buildCommand: (display) => `npx clawhub@latest run "Read ${SKILL_URL} and ${display}"`
  },
  {
    id: 'hermes',
    label: 'Hermes',
    color: '#EC4899',
    terminalPrefix: 'hermes',
    buildCommand: (display) => `hermes "Read ${SKILL_URL} and ${display}"`
  }
];

const USE_CASES: { label: string; display: string; icon: ElementType }[] = [
  {
    label: 'Read Twitter/X profiles & tweets',
    display:
      'Use x402 to read a Twitter/X profile and recent tweets. Get follower counts, recent tweets, and engagement metrics.',
    icon: Twitter
  },
  {
    label: 'Score a sales lead',
    display:
      'Score any company domain as a B2B sales lead. Get a 0–100 score and A–F grade from various signals.',
    icon: BarChart2
  },
  {
    label: 'Make a bet on polymarket',
    display: 'Make a bet on a Polymarket market. Get the latest market prices and outcomes.',
    icon: Target
  },
  {
    label: 'Bridge assets cross-chain',
    display:
      'Bridge some USDC from Polygon to Base using the cheapest available route. Confirm the arrival and report the final balance on both chains.',
    icon: ArrowLeftRight
  },
  {
    label: 'Automate yield strategies',
    display:
      'Deposit USDC into the highest-TVL lending vault on Polygon or Katana with TVL above $100M and report the APY and pool address. Then set up a daily cron job to automatically re-evaluate and deposit into the best vault each morning.',
    icon: TrendingUp
  }
];

// --- Main App ---

function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const rid = params.get('rid') || '';
  const walletName = params.get('wallet') || '';

  const chainId = useMemo(() => resolveChainId(params), [params]);

  const [error, setError] = useState<string>('');
  const [walletAddress, setWalletAddress] = useState<string>('');
  const [cliPkHex, setCliPkHex] = useState<string>('');
  const [sessionCode, setSessionCode] = useState<string>('');
  const [showFunding, setShowFunding] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const [feeTokens, setFeeTokens] = useState<any | null>(null);
  const [selectedUseCase, setSelectedUseCase] = useState(0);
  const [selectedAgent, setSelectedAgent] = useState<string>('claude');
  const [copied, setCopied] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [totalUsd, setTotalUsd] = useState<number | null>(null);

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

  // Fetch USD portfolio balance when wallet address is first known
  useEffect(() => {
    if (!walletAddress) return;
    setTotalUsd(null);
    fetchTotalUsdBalance(walletAddress, chainId)
      .then(setTotalUsd)
      .catch(() => setTotalUsd(null));
  }, [walletAddress, chainId]);

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
    setConnecting(true);

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
          ...oneOffErc20Permissions,
          ...openTokenPermissions,
          ...dynamicTokenPermissions,
          ...nativeFeePermission,
          ...feePermissions,
          ...contractWhitelistPermissions
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
      setConnecting(false);
    } catch (e: any) {
      console.error(e);
      setError(e?.message || String(e));
      setConnecting(false);
    }
  };

  const shortAddr = walletAddress
    ? `${walletAddress.slice(0, 6)}..${walletAddress.slice(-4)}`
    : null;

  // ── Screen 1: Connecting (no wallet yet, or encrypting) ──
  if (!walletAddress || (walletAddress && !sessionCode && !showFunding && !showDashboard)) {
    const isWaiting = connecting || (walletAddress && !sessionCode);
    return (
      <div className="min-h-screen bg-[#f5f6fb] flex flex-col items-center justify-center px-4">
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[99999] flex items-center gap-2.5">
          <img src="/polygon-logo-full.webp" alt="Polygon" className="h-8 w-auto" />
          <span className="font-mono text-xs bg-[#141635] text-white px-2 py-0.5 rounded-md tracking-tight">
            &gt;_ agent
          </span>
        </div>
        <div
          className="w-full max-w-sm bg-white rounded-3xl border border-[#c8cfe1] overflow-hidden"
          style={{ boxShadow: '0 2px 8px rgba(20,22,53,0.06), 0 16px 48px rgba(20,22,53,0.08)' }}
        >
          {/* Header */}
          <div className="px-8 pt-8 pb-6 flex flex-col items-center gap-3 text-center">
            <h1 className="text-lg font-bold text-[#141635]">Connect your agent wallet</h1>
            <p className="text-sm text-[#64708f] leading-relaxed">
              Create a secure session to authorize onchain operations
            </p>
          </div>

          <div className="px-8 pb-8 flex flex-col items-center gap-4">
            {isWaiting ? (
              <div className="flex items-center gap-2.5 text-sm text-[#64708f] py-2">
                <div
                  className="w-4 h-4 rounded-full border-2 border-[#7c3aed] border-t-transparent flex-shrink-0"
                  style={{ animation: 'spin 0.8s linear infinite' }}
                />
                Waiting for wallet authorization…
              </div>
            ) : (
              <button
                onClick={connect}
                className="btn-press w-full flex items-center justify-center gap-2 bg-[#141635] hover:bg-[#1e2155] text-white text-sm font-bold px-5 py-3 rounded-xl transition-colors cursor-pointer border-0"
              >
                <Wallet className="w-4 h-4" />
                Sign In
              </button>
            )}

            {error && (
              <div className="w-full flex items-start gap-2.5 px-4 py-3 rounded-xl bg-red-50 border border-red-100">
                <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-red-600">{error}</p>
                  <button
                    onClick={connect}
                    className="mt-1.5 text-xs text-[#7c3aed] hover:text-[#6d28d9] font-medium cursor-pointer border-0 bg-transparent transition-colors"
                  >
                    Try again →
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-[#c8cfe1] px-8 py-3 flex items-center justify-center gap-1.5">
            <span className="text-xs text-[#64708f]">Powered by</span>
            <img src="/polygon-logo-full.webp" alt="Polygon" className="h-3.5 w-auto opacity-40" />
          </div>
        </div>
      </div>
    );
  }

  // ── Screen 2: Code confirm ──
  if (sessionCode && !showFunding && !showDashboard) {
    return (
      <div className="min-h-screen bg-[#f5f6fb] flex flex-col items-center justify-center px-4">
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[99999] flex items-center gap-2.5">
          <img src="/polygon-logo-full.webp" alt="Polygon" className="h-8 w-auto" />
          <span className="font-mono text-xs bg-[#141635] text-white px-2 py-0.5 rounded-md tracking-tight">
            &gt;_ agent
          </span>
        </div>
        <CodeDisplay
          code={sessionCode}
          walletAddress={walletAddress}
          totalUsd={totalUsd}
          onContinue={() => setShowFunding(true)}
          onRegenerate={() => {
            setSessionCode('');
            void connect();
          }}
        />
      </div>
    );
  }

  // ── Screen 3: Funding ──
  if (showFunding && !showDashboard) {
    return (
      <div className="min-h-screen bg-[#f5f6fb] flex flex-col items-center justify-center px-4">
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[99999] flex items-center gap-2.5">
          <img src="/polygon-logo-full.webp" alt="Polygon" className="h-8 w-auto" />
          <span className="font-mono text-xs bg-[#141635] text-white px-2 py-0.5 rounded-md tracking-tight">
            &gt;_ agent
          </span>
        </div>
        <div className="w-full max-w-sm">
          <FundingScreen
            walletAddress={walletAddress}
            chainId={chainId}
            onSkip={() => {
              setShowDashboard(true);
              setTotalUsd(null);
              fetchTotalUsdBalance(walletAddress, chainId)
                .then(setTotalUsd)
                .catch(() => setTotalUsd(null));
            }}
          />
        </div>
      </div>
    );
  }

  // ── Screen 4: Dashboard ──
  return (
    <div className="min-h-screen bg-[#f5f6fb]">
      {/* Nav */}
      <nav className="bg-white border-b border-[#c8cfe1] px-6 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src="/polygon-logo-full.webp" alt="Polygon" className="h-7 w-auto" />
          <span className="font-mono text-xs bg-[#141635] text-white px-2 py-0.5 rounded-md tracking-tight">
            &gt;_ agent
          </span>
        </div>
        <a
          href="https://wallet.polygon.technology"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 bg-[#f5f6fb] hover:bg-[#eef0f8] border border-[#c8cfe1] rounded-full px-3 py-1.5 transition-colors no-underline"
        >
          <div className="w-5 h-5 rounded-full bg-gradient-to-br from-[#7c3aed] to-[#a78bfa] flex-shrink-0" />
          <span className="font-mono text-sm text-[#141635]">{shortAddr}</span>
        </a>
      </nav>

      <main className="max-w-4xl mx-auto px-6 py-8">
        {/* Balance row */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <div className="text-5xl font-bold text-[#141635] mb-2 leading-none">
              {totalUsd === null ? (
                <span className="text-[#c8cfe1]">$—</span>
              ) : (
                `$${totalUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              )}
            </div>
            <div className="flex items-center gap-2 mt-2">
              <div className="w-2 h-2 rounded-full bg-[#7c3aed]" />
              <span className="font-mono text-xs text-[#64708f]">{walletAddress}</span>
            </div>
          </div>
          <button
            onClick={() => {
              setShowFunding(true);
              setShowDashboard(false);
            }}
            className="btn-press flex items-center gap-2 bg-[#141635] hover:bg-[#1e2155] text-white font-bold px-5 py-2.5 rounded-xl transition-colors cursor-pointer border-0 text-sm"
          >
            <Plus className="w-4 h-4" />
            Add funds
          </button>
        </div>

        {/* Section header */}
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-base font-bold text-[#141635]">Use your wallet with agents</h2>
          <span className="flex items-center gap-1.5 text-xs text-[#16a34a] bg-[#f0fdf4] border border-[#bbf7d0] px-2.5 py-1 rounded-full font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-[#16a34a] inline-block" />
            polygon-agent connected
          </span>
        </div>

        {/* Use cases + terminal */}
        <div className="grid grid-cols-2 gap-0 bg-white rounded-3xl border border-[#c8cfe1] overflow-hidden mb-4">
          {/* Left: use cases */}
          <div className="p-5 border-r border-[#c8cfe1]">
            <div className="space-y-1">
              {USE_CASES.map((uc, i) => {
                const Icon = uc.icon;
                return (
                  <button
                    key={uc.label}
                    onClick={() => setSelectedUseCase(i)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm text-left cursor-pointer transition-colors ${
                      i === selectedUseCase
                        ? 'bg-[#f5f6fb] text-[#141635] font-bold'
                        : 'text-[#64708f] hover:bg-[#f9f9fd] font-medium'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5 flex-shrink-0 text-[#7c3aed]" />
                    {uc.label}
                  </button>
                );
              })}
            </div>
            <a
              href="https://github.com/0xPolygon/polygon-agent-cli"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 w-full flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl border border-[#c8cfe1] text-sm text-[#64708f] bg-transparent cursor-pointer hover:bg-[#f5f6fb] transition-all hover:border-[#929eba] no-underline font-medium"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path
                  d="M7 17L17 7M17 7H7M17 7V17"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              See all use cases
            </a>
          </div>

          {/* Right: terminal */}
          <div className="p-5 flex flex-col">
            <pre className="text-xs leading-relaxed flex-1 text-[#64708f] whitespace-pre-wrap font-mono">
              <span
                className="font-semibold"
                style={{ color: AGENTS.find((a) => a.id === selectedAgent)?.color }}
              >
                {AGENTS.find((a) => a.id === selectedAgent)?.terminalPrefix}
              </span>
              {' "'}
              {USE_CASES[selectedUseCase].display}"
            </pre>
            <div className="mt-3 pt-3 border-t border-[#c8cfe1]">
              {/* Agent selector chips */}
              <div className="flex items-center gap-1.5 mb-3">
                <span className="text-xs text-[#64708f] mr-0.5">Run with</span>
                {AGENTS.map((agent) => (
                  <button
                    key={agent.id}
                    onClick={() => setSelectedAgent(agent.id)}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold transition-all cursor-pointer border ${
                      selectedAgent === agent.id
                        ? 'text-white border-transparent'
                        : 'bg-white text-[#64708f] border-[#c8cfe1] hover:border-[#929eba]'
                    }`}
                    style={
                      selectedAgent === agent.id
                        ? { background: agent.color, borderColor: agent.color }
                        : {}
                    }
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full"
                      style={{
                        background:
                          selectedAgent === agent.id ? 'rgba(255,255,255,0.7)' : agent.color
                      }}
                    />
                    {agent.label}
                  </button>
                ))}
              </div>
              <button
                onClick={() => {
                  const agent = AGENTS.find((a) => a.id === selectedAgent)!;
                  void navigator.clipboard
                    .writeText(agent.buildCommand(USE_CASES[selectedUseCase].display))
                    .then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    });
                }}
                className="w-full flex items-center justify-center gap-2 border border-[#c8cfe1] rounded-xl py-2.5 text-sm text-[#141635] font-bold hover:bg-[#f5f6fb] hover:border-[#929eba] transition-all cursor-pointer bg-white"
              >
                <Copy className="w-4 h-4" />
                {copied ? 'Copied!' : 'Copy to your terminal'}
              </button>
            </div>
          </div>
        </div>

        {/* Learn more */}
        <h3 className="text-base font-bold text-[#141635] mb-3 mt-8">Learn more</h3>
        <div className="grid grid-cols-3 gap-3 mb-6">
          {[
            {
              title: 'Github',
              desc: 'Browse the source code, open issues, and contribute to the Polygon Agent CLI.',
              href: 'https://github.com/0xPolygon/polygon-agent-cli'
            },
            {
              title: 'Docs',
              desc: 'Full CLI reference, quickstart guide, and architecture docs to get your agent onchain fast.',
              href: 'https://polygon-labs.mintlify.io/wallets/agentic-wallets'
            }
          ].map((card) => (
            <a
              key={card.title}
              href={card.href}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-white rounded-3xl border border-[#c8cfe1] p-6 no-underline block hover:border-[#929eba] transition-all group"
              style={{ boxShadow: '0 1px 4px rgba(20,22,53,0.04)' }}
            >
              <div className="flex items-start justify-between mb-3">
                <span className="text-base font-bold text-[#141635]">{card.title}</span>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  className="text-[#929eba] mt-0.5 flex-shrink-0"
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
              <p className="text-sm text-[#64708f] leading-relaxed font-medium">{card.desc}</p>
            </a>
          ))}
        </div>

        <div className="text-center py-4 text-xs text-[#929eba] font-medium">
          Powered by Polygon
        </div>
      </main>
    </div>
  );
}

export { App };

import './App.css';

import type { ElementType } from 'react';

import {
  AlertCircle,
  ArrowLeftRight,
  BarChart2,
  Copy,
  Plus,
  Target,
  TrendingUp,
  Twitter
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { FundingScreen } from './components/FundingScreen.js';
import { fetchTotalUsdBalance } from './indexer';

type View = 'fund' | 'dashboard';

const WALLET_URL = 'https://wallet.polygon.technology';
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
      'Deposit USDC into the highest-yield active lending vault on Polygon and report the APY and pool address. Then set up a daily cron job to automatically re-evaluate and deposit into the best vault each morning.',
    icon: TrendingUp
  }
];

// Shared logo header used on every screen.
function LogoBadge() {
  return (
    <div className="flex items-center gap-2.5">
      <img src="/polygon-logo-full.webp" alt="Polygon" className="h-7 w-auto" />
      <span className="font-mono text-xs bg-[#141635] text-white px-2 py-0.5 rounded-md tracking-tight">
        &gt;_ agent
      </span>
    </div>
  );
}

// ── Dashboard: balance header, use-case picker + terminal, learn-more cards ──
function Dashboard({
  walletAddress,
  chainId,
  onAddFunds
}: {
  walletAddress: string;
  chainId: number;
  onAddFunds: () => void;
}) {
  const [totalUsd, setTotalUsd] = useState<number | null>(null);
  const [selectedUseCase, setSelectedUseCase] = useState(0);
  const [selectedAgent, setSelectedAgent] = useState<string>('claude');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    setTotalUsd(null);
    fetchTotalUsdBalance(walletAddress, chainId)
      .then((v) => {
        if (active) setTotalUsd(v);
      })
      .catch(() => {
        if (active) setTotalUsd(null);
      });
    return () => {
      active = false;
    };
  }, [walletAddress, chainId]);

  const shortAddr = `${walletAddress.slice(0, 6)}..${walletAddress.slice(-4)}`;

  return (
    <div className="min-h-screen bg-[#f5f6fb]">
      {/* Nav */}
      <nav className="bg-white border-b border-[#c8cfe1] px-6 py-3.5 flex items-center justify-between">
        <LogoBadge />
        <a
          href={WALLET_URL}
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
                `$${totalUsd.toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2
                })}`
              )}
            </div>
            <div className="flex items-center gap-2 mt-2">
              <div className="w-2 h-2 rounded-full bg-[#7c3aed]" />
              <span className="font-mono text-xs text-[#64708f]">{walletAddress}</span>
            </div>
          </div>
          <button
            onClick={onAddFunds}
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
              href: 'https://docs.polygon.technology/payment-services/agentic-payments/polygon-agent-cli'
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

// ── Centered notice shown when opened without a wallet param ──
function MissingWalletNotice() {
  return (
    <div className="min-h-screen bg-[#f5f6fb] flex flex-col items-center justify-center px-4">
      <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[99999]">
        <LogoBadge />
      </div>
      <div
        className="w-full max-w-sm bg-white rounded-3xl border border-[#c8cfe1] px-8 py-8 flex flex-col items-center gap-3 text-center"
        style={{ boxShadow: '0 2px 8px rgba(20,22,53,0.06), 0 16px 48px rgba(20,22,53,0.08)' }}
      >
        <AlertCircle className="w-6 h-6 text-[#7c3aed]" />
        <p className="text-sm text-[#64708f] leading-relaxed font-medium">
          Open this page from the polygon-agent CLI.
        </p>
      </div>
    </div>
  );
}

// ── Main App ──
function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const walletAddress = params.get('wallet') || '';
  const chainId = Number(params.get('chain') || '137');

  const initialView: View = params.get('view') === 'fund' ? 'fund' : 'dashboard';
  const [view, setView] = useState<View>(initialView);

  if (!walletAddress) {
    return <MissingWalletNotice />;
  }

  if (view === 'fund') {
    return (
      <div className="min-h-screen bg-[#f5f6fb] flex flex-col items-center justify-center px-4">
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[99999]">
          <LogoBadge />
        </div>
        <FundingScreen
          walletAddress={walletAddress}
          chainId={chainId}
          onSkip={() => setView('dashboard')}
        />
      </div>
    );
  }

  return (
    <Dashboard walletAddress={walletAddress} chainId={chainId} onAddFunds={() => setView('fund')} />
  );
}

export { App };

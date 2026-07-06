import './App.css';

import { AlertCircle, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { FundingScreen } from './components/FundingScreen.js';
import { fetchTotalUsdBalance } from './indexer';

type View = 'fund' | 'dashboard';

const WALLET_URL = 'https://wallet.polygon.technology';

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

// ── Minimal dashboard: short address, add funds, best-effort USD balance ──
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

import { Copy, Check, CreditCard, ArrowRight } from 'lucide-react';
import { useState } from 'react';

interface FundingScreenProps {
  walletAddress: string;
  chainId: number;
  projectAccessKey: string;
  onSkip: () => void;
}

const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
export function FundingScreen({
  walletAddress,
  chainId,
  projectAccessKey,
  onSkip
}: FundingScreenProps) {
  const [copiedAddr, setCopiedAddr] = useState(false);

  const trailsUrl = `https://demo.trails.build/?mode=swap&toAddress=${walletAddress}&toChainId=${chainId}&toToken=${USDC_POLYGON}&apiKey=${projectAccessKey}&theme=light`;

  const shortAddr = walletAddress
    ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`
    : '';

  function handleCopyAddr() {
    navigator.clipboard.writeText(walletAddress).catch(() => {});
    setCopiedAddr(true);
    setTimeout(() => setCopiedAddr(false), 2000);
  }

  return (
    <div className="bg-white rounded-2xl border border-[#e5e5f0] p-6 animate-scale-in">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-[#0f0f1a]">Fund your agent wallet</h2>
          <p className="text-sm text-[#6b7280] mt-0.5">Add USDC to start running on-chain tasks</p>
        </div>
        <button
          onClick={onSkip}
          className="text-sm text-[#8247e5] hover:text-[#7139d4] font-medium transition-colors cursor-pointer border-0 bg-transparent whitespace-nowrap"
        >
          Skip for now →
        </button>
      </div>

      {/* Wallet address chip */}
      <div className="flex items-center gap-2 bg-[#f3f4f8] rounded-xl px-4 py-3 mb-5">
        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-[#8247e5] to-[#c084fc] flex-shrink-0" />
        <span className="text-sm font-mono text-[#374151] flex-1">{shortAddr}</span>
        <button
          onClick={handleCopyAddr}
          className="text-[#9ca3af] hover:text-[#6b7280] transition-colors cursor-pointer border-0 bg-transparent p-0.5"
        >
          {copiedAddr ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>

      {/* Option 1: Card */}
      <a
        href={trailsUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="btn-press flex items-center gap-3 w-full bg-[#8247e5] hover:bg-[#7139d4] text-white rounded-xl px-4 py-4 mb-3 transition-colors no-underline"
      >
        <div className="w-9 h-9 bg-white/20 rounded-lg flex items-center justify-center flex-shrink-0">
          <CreditCard className="w-5 h-5" />
        </div>
        <div className="flex-1 text-left">
          <div className="font-semibold text-sm">Add funds with card</div>
          <div className="text-xs text-white/70 mt-0.5">Buy USDC instantly via Trails</div>
        </div>
        <ArrowRight className="w-4 h-4 opacity-70" />
      </a>

      {/* Option 2: Send from wallet */}
      <div className="border border-[#e5e5f0] rounded-xl px-4 py-4 mb-5">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-9 h-9 bg-[#f3f4f8] rounded-lg flex items-center justify-center flex-shrink-0">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="text-[#374151]">
              <path
                d="M3 6h18M3 12h18M3 18h18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <div>
            <div className="font-semibold text-sm text-[#0f0f1a]">Transfer from wallet</div>
            <div className="text-xs text-[#9ca3af]">Send USDC to your agent address</div>
          </div>
        </div>
        <div className="flex items-center gap-2 bg-[#f3f4f8] rounded-lg px-3 py-2.5">
          <span className="text-xs font-mono text-[#374151] flex-1 break-all">{walletAddress}</span>
          <button
            onClick={handleCopyAddr}
            className="text-[#9ca3af] hover:text-[#6b7280] transition-colors cursor-pointer border-0 bg-transparent p-0.5 flex-shrink-0"
          >
            {copiedAddr ? (
              <Check className="w-3.5 h-3.5 text-green-600" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Skip */}
      <button
        onClick={onSkip}
        className="w-full text-sm text-[#9ca3af] hover:text-[#6b7280] transition-colors cursor-pointer border-0 bg-transparent py-1"
      >
        I'll fund it later — take me to agent.polygon.technology
      </button>
    </div>
  );
}

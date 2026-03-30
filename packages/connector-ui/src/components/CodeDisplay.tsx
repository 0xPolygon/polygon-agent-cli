import { Copy, Check, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

interface CodeDisplayProps {
  code: string;
  walletAddress: string;
  totalUsd: number | null;
  onContinue: () => void;
  onRegenerate: () => void;
}

export function CodeDisplay({ code, walletAddress, totalUsd, onRegenerate }: CodeDisplayProps) {
  const [copied, setCopied] = useState(false);
  const [seconds, setSeconds] = useState(300); // matches relay 5-min TTL

  const displayCode = `${code.slice(0, 3)} - ${code.slice(3)}`;

  const shortAddr = walletAddress ? `${walletAddress.slice(0, 6)}..${walletAddress.slice(-4)}` : '';

  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, []);

  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;

  function handleCopy() {
    navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="bg-white rounded-2xl border border-[#e5e5f0] w-full max-w-sm mx-auto overflow-hidden">
      {/* Wallet chip header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-[#f0f0f5]">
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#8247e5] to-[#c084fc] flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-mono font-medium text-[#0f0f1a] truncate">{shortAddr}</div>
          <div className="text-xs text-[#9ca3af]">
            {totalUsd === null
              ? '—'
              : `$${totalUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          </div>
        </div>
      </div>

      {/* Code section */}
      <div className="px-5 py-6">
        <h2 className="text-base font-semibold text-[#0f0f1a] mb-1">Confirm your code</h2>
        <p className="text-sm text-[#9ca3af] mb-5">
          Enter this code in your terminal or send it to your agent
        </p>

        {/* Code box */}
        <div className="flex items-center gap-3 border border-[#e5e5f0] rounded-xl px-4 py-3.5 mb-3">
          <span className="flex-1 text-center text-xl font-mono font-bold tracking-[0.25em] text-[#0f0f1a] select-all">
            {displayCode}
          </span>
          <button
            onClick={handleCopy}
            className="text-[#9ca3af] hover:text-[#6b7280] transition-colors cursor-pointer border-0 bg-transparent p-1 flex-shrink-0"
          >
            {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
          </button>
        </div>

        {/* Expiry + regenerate */}
        <div className="flex items-center justify-center gap-1.5 text-xs text-[#9ca3af]">
          <span>Expires in {timeStr}</span>
          <span>·</span>
          <button
            onClick={onRegenerate}
            className="flex items-center gap-1 text-[#8247e5] hover:text-[#7139d4] transition-colors cursor-pointer border-0 bg-transparent font-medium"
          >
            Generate new code
            <RefreshCw className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-[#f0f0f5] px-5 py-3 flex items-center justify-center gap-1.5">
        <span className="text-xs text-[#9ca3af]">Powered by</span>
        <img src="/polygon-logo-full.webp" alt="Polygon" className="h-3.5 w-auto opacity-50" />
      </div>
    </div>
  );
}

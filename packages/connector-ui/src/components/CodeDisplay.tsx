import { Copy, Check } from 'lucide-react';
import { useEffect, useState } from 'react';

interface CodeDisplayProps {
  code: string;
  onContinue: () => void;
}

export function CodeDisplay({ code, onContinue }: CodeDisplayProps) {
  const [copied, setCopied] = useState(false);
  const [seconds, setSeconds] = useState(300); // matches relay 5-min TTL

  // Display as "XXX - XXX"
  const displayCode = `${code.slice(0, 3)} - ${code.slice(3)}`;

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
    <div className="bg-white rounded-2xl border border-[#e5e5f0] p-6 animate-slide-up">
      <p className="text-center text-[#374151] font-medium mb-5">
        Enter this code in your terminal or agent:
      </p>

      {/* Code box */}
      <div className="flex items-center gap-3 bg-[#f3f4f8] rounded-xl px-5 py-4 mb-3">
        <span className="flex-1 text-center text-2xl font-mono font-bold tracking-[0.2em] text-[#0f0f1a] select-all">
          {displayCode}
        </span>
        <button
          onClick={handleCopy}
          className="text-[#9ca3af] hover:text-[#6b7280] transition-colors cursor-pointer border-0 bg-transparent p-1"
        >
          {copied ? <Check className="w-5 h-5 text-green-600" /> : <Copy className="w-5 h-5" />}
        </button>
      </div>

      <p className="text-center text-sm text-[#9ca3af] mb-5">Expires in {timeStr}</p>

      {/* Fallback continue button */}
      <button
        onClick={onContinue}
        className="btn-press w-full h-10 rounded-xl bg-[#8247e5] text-white text-sm font-semibold hover:bg-[#7139d4] transition-colors cursor-pointer border-0"
      >
        Continue to fund wallet →
      </button>
    </div>
  );
}

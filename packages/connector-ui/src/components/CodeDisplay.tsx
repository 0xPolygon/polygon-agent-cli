// packages/connector-ui/src/components/CodeDisplay.tsx
import { Copy, Check } from 'lucide-react';
import { useState } from 'react';

interface CodeDisplayProps {
  code: string;
  walletAddress: string;
  walletName: string;
}

export function CodeDisplay({ code, walletAddress, walletName }: CodeDisplayProps) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const digits = code.split('');

  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <div className="flex flex-col items-center gap-2">
        <h2 className="text-xl font-semibold text-text-primary">Session approved</h2>
        <p className="text-sm text-text-secondary">
          Enter this code in your terminal or agent to complete setup
        </p>
      </div>

      <div className="flex gap-2">
        {digits.map((d, i) => (
          <div
            key={i}
            className="w-10 h-12 flex items-center justify-center rounded-lg bg-surface-elevated border border-border text-2xl font-mono font-bold text-text-primary"
          >
            {d}
          </div>
        ))}
      </div>

      <button
        onClick={handleCopy}
        className="flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary transition-colors cursor-pointer border-0 bg-transparent"
      >
        {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
        {copied ? 'Copied' : 'Copy code'}
      </button>

      <div className="w-full rounded-xl bg-surface-elevated border border-border p-3 text-left space-y-1">
        <div className="flex justify-between text-xs">
          <span className="text-text-muted">Wallet</span>
          <span className="text-text-secondary font-mono">{walletName}</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-text-muted">Address</span>
          <span className="text-text-secondary font-mono text-right break-all">
            {walletAddress}
          </span>
        </div>
      </div>

      <p className="text-xs text-text-muted">This code expires in 5 minutes. Do not share it.</p>
    </div>
  );
}

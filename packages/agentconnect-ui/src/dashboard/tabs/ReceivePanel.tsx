import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@polygonlabs/design-system';

interface ReceivePanelProps {
  address: string;
}

export function ReceivePanel({ address }: ReceivePanelProps) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="bg-background-info border border-purple-200 rounded-2xl px-5 py-4 flex flex-wrap gap-3 items-center justify-between">
      <span className="flex flex-col gap-1 min-w-0">
        <span className="text-sm font-bold">Receive from another wallet or exchange</span>
        <span className="oms-mono text-[13px] text-slate-600 break-all">{address}</span>
        <span className="text-xs text-muted">Send only on the Polygon network.</span>
      </span>
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          void navigator.clipboard?.writeText(address).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
      >
        {copied ? <Check /> : <Copy />}
        {copied ? 'Copied' : 'Copy address'}
      </Button>
    </div>
  );
}

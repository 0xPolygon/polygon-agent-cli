import { Check, Copy } from 'lucide-react';

import { Button } from '@polygonlabs/design-system';

import { sentence } from '../utils/format.js';

interface PromptRowProps {
  text: string;
  copied: boolean;
  onCopy: () => void;
}

export function PromptRow({ text, copied, onCopy }: PromptRowProps) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-background-info px-3 py-2">
      <span className="min-w-0 flex-1 text-xs font-medium leading-snug text-muted">
        {sentence(text)}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={copied ? 'Copied' : 'Copy prompt'}
        onClick={onCopy}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </Button>
    </div>
  );
}

import { CommandLine } from './CommandLine.js';
import { CopyButton } from './CopyButton.js';

interface PromptRowProps {
  text: string;
  copied: boolean;
  onCopy: () => void;
}

export function PromptRow({ text, copied, onCopy }: PromptRowProps) {
  return (
    <div className="flex items-center gap-3.5 py-3.5">
      <span className="flex-1 min-w-0">
        <CommandLine text={text} />
      </span>
      <CopyButton size="default" copied={copied} onClick={onCopy} className="flex-shrink-0" />
    </div>
  );
}

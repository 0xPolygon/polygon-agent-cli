import { buildPrompt } from '../dashboard/agents.js';
import { CommandLine } from './CommandLine.js';
import { CopyButton } from './CopyButton.js';

interface AgentPromptBoxProps {
  text: string;
  skill: string;
  id: string;
  copied: string | null;
  copy: (id: string, text: string) => void;
}

export function AgentPromptBox({ text, skill, id, copied, copy }: AgentPromptBoxProps) {
  return (
    <div className="flex flex-col gap-4">
      <CommandLine text={text} />
      <CopyButton
        copied={copied === id}
        onClick={() => copy(id, buildPrompt(text, skill))}
        className="w-full"
      />
    </div>
  );
}

import { sentence } from '../utils/format.js';

interface CommandLineProps {
  text: string;
}

/** The prompt as the visitor will paste it into any agent. */
export function CommandLine({ text }: CommandLineProps) {
  return (
    <code className="font-mono text-[13px] leading-relaxed text-slate-600 break-words">
      {sentence(text)}
    </code>
  );
}

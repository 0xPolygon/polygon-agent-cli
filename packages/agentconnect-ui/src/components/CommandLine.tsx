import { sentence } from '../utils/format.js';

interface CommandLineProps {
  text: string;
}

export function CommandLine({ text }: CommandLineProps) {
  return (
    <code className="font-mono text-[13px] leading-relaxed text-slate-600 break-words">
      {sentence(text)}
    </code>
  );
}

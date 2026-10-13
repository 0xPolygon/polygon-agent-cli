import type { ReactNode } from 'react';

import { CircleCheckBig, Copy, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { buildPrompt } from './agents.js';

export const usd = (n: number) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const signedUsd = (n: number) => (n < 0 ? '-' : '+') + usd(Math.abs(n));

export const shortAddr = (a: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

export function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Copy text and flip a label to "Copied" for a moment. */
export function useCopy(): [string | null, (id: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback((id: string, text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(id);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 1600);
  }, []);
  return [copied, copy];
}

export function Panel({
  children,
  className = '',
  pad = 'p-6'
}: {
  children: ReactNode;
  className?: string;
  pad?: string;
}) {
  return (
    <div className={`bg-white border border-[var(--slate-200)] rounded-3xl ${pad} ${className}`}>
      {children}
    </div>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-lg font-bold">{children}</span>
      {aside}
    </div>
  );
}

/** A divided list inside a panel; each row gets a hairline except the last. */
export function RowList({ children }: { children: ReactNode }) {
  return (
    <Panel pad="px-5 py-1">
      <div className="divide-y divide-[var(--slate-100)]">{children}</div>
    </Panel>
  );
}

export function IconTile({ icon: Icon, size = 40 }: { icon: React.ElementType; size?: number }) {
  return (
    <span
      className="rounded-xl bg-[var(--purple-50)] flex items-center justify-center flex-shrink-0"
      style={{ width: size, height: size }}
    >
      <Icon className="w-[18px] h-[18px] text-[var(--purple-500)]" />
    </span>
  );
}

export function Chip({
  active,
  onClick,
  children,
  size = 'md'
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  size?: 'sm' | 'md';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${size === 'sm' ? 'h-[30px] px-3 text-[13px]' : 'h-9 px-4 text-sm'} rounded-full border font-bold cursor-pointer transition-colors ${
        active
          ? 'bg-[var(--slate-900)] border-[var(--slate-900)] text-white'
          : 'bg-white border-[var(--slate-200)] text-[var(--slate-600)] hover:border-[var(--slate-400)]'
      }`}
    >
      {children}
    </button>
  );
}

/** Square-ish option chips for amounts (top-up, limits). */
export function AmountChips({
  values,
  value,
  onPick,
  format = (v: number) => '$' + v.toLocaleString('en-US')
}: {
  values: number[];
  value: number;
  onPick: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {values.map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onPick(v)}
          className={`h-11 rounded-xl border text-[15px] font-bold text-[var(--slate-900)] cursor-pointer transition-colors ${
            v === value
              ? 'border-[var(--slate-900)] bg-[var(--purple-50)]'
              : 'border-[var(--slate-200)] bg-white hover:border-[var(--slate-400)]'
          }`}
        >
          {format(v)}
        </button>
      ))}
    </div>
  );
}

/** The prompt as the visitor will paste it into any agent. */
export function CommandLine({ text }: { text: string }) {
  return (
    <code className="oms-mono text-[13px] leading-relaxed text-[var(--slate-600)] break-words">
      {sentence(text)}
    </code>
  );
}

export function CopyButton({
  copied,
  onClick,
  label = 'Copy',
  size = 'lg',
  className = ''
}: {
  copied: boolean;
  onClick: () => void;
  label?: string;
  size?: 'lg' | 'md';
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`btn btn-secondary btn-${size} ${className}`}
    >
      {size === 'lg' && <Copy className="w-4 h-4" />}
      {copied ? 'Copied' : label}
    </button>
  );
}

/** A self-contained "ask your agent" block: the prompt and a copy button. */
export function AgentPromptBox({
  text,
  skill,
  id,
  copied,
  copy
}: {
  text: string;
  skill: string;
  id: string;
  copied: string | null;
  copy: (id: string, text: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <CommandLine text={text} />
      <CopyButton
        copied={copied === id}
        onClick={() => copy(id, buildPrompt(text, skill))}
        className="w-full h-11"
      />
    </div>
  );
}

export function Toggle({
  on,
  onClick,
  label
}: {
  on: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      className="relative w-11 h-[26px] flex-shrink-0 rounded-full border-0 p-0 cursor-pointer transition-colors"
      style={{ background: on ? 'var(--purple-500)' : 'var(--slate-300)' }}
    >
      <span
        className="absolute top-[3px] w-5 h-5 rounded-full bg-white transition-[left] duration-100"
        style={{ left: on ? 21 : 3 }}
      />
    </button>
  );
}

/** Bottom sheet on phones, centered dialog on larger screens. */
export function Modal({
  title,
  sub,
  onClose,
  children
}: {
  title: string;
  sub?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center md:p-6 bg-[rgba(2,0,5,0.2)] overflow-y-auto"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="animate-scale-in w-full max-w-[420px] bg-white rounded-t-3xl md:rounded-3xl p-6 flex flex-col gap-5 shadow-[var(--shadow-modal)] max-h-[100dvh] overflow-y-auto"
      >
        <div className="flex justify-between items-start gap-3">
          <span className="flex flex-col gap-1.5">
            <span className="text-[22px] font-bold">{title}</span>
            {sub && <span className="text-sm text-[var(--slate-500)] leading-snug">{sub}</span>}
          </span>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="w-8 h-8 flex-shrink-0 border-0 bg-[var(--slate-50)] rounded-lg cursor-pointer flex items-center justify-center"
          >
            <X className="w-4 h-4 text-[var(--slate-600)]" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Toast({ message, raised }: { message: string; raised: boolean }) {
  return (
    <div
      role="status"
      className={`fixed left-1/2 -translate-x-1/2 ${raised ? 'bottom-24' : 'bottom-8'} md:bottom-8 bg-[var(--slate-900)] text-white px-[18px] py-3 rounded-xl text-sm font-bold z-[60] flex items-center gap-2.5 shadow-[var(--shadow-popover)]`}
    >
      <CircleCheckBig className="w-4 h-4 text-[var(--emerald-400)]" />
      {message}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="py-8 flex flex-col items-center gap-1.5 text-center">
      <span className="text-[15px] font-bold">{title}</span>
      {children && <span className="text-[13px] text-[var(--slate-500)] max-w-sm">{children}</span>}
    </div>
  );
}

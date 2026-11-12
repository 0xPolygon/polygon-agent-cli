import type { ReactNode } from 'react';

interface StatLineProps {
  label: string;
  children: ReactNode;
}

export function StatLine({ label, children }: StatLineProps) {
  return (
    <div className="flex items-baseline gap-1">
      <dt className="text-sm font-medium">{label}</dt>
      <span
        aria-hidden="true"
        className="mb-1 min-w-4 flex-1 border-b-2 border-dotted border-slate-300"
      />
      <dd className="m-0 text-xl font-bold">{children}</dd>
    </div>
  );
}

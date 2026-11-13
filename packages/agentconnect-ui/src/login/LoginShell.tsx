import type { ReactNode } from 'react';

import { LogoBadge } from '../App.js';

interface LoginShellProps {
  children: ReactNode;
}

export function LoginShell({ children }: LoginShellProps) {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center bg-white px-4 py-6 text-primary sm:py-17">
      {/* In flow on phones; from sm up it sits at the page top and scrolls away with it. */}
      <div className="mb-6 sm:absolute sm:top-6 sm:left-1/2 sm:mb-0 sm:-translate-x-1/2">
        <LogoBadge />
      </div>
      <div className="flex w-full max-w-md flex-col gap-6 rounded-3xl border border-slate-200 bg-white px-7 py-8">
        {children}
      </div>
    </div>
  );
}

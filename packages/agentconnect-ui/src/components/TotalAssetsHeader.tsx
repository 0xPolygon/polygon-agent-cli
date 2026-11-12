import type { ReactNode } from 'react';

import { cn, Separator } from '@polygonlabs/design-system';

import { usd } from '../utils/format.js';
import { Money } from './Money.js';

interface TotalAssetsHeaderProps {
  label: string;
  total: number | null;
  failed: boolean;
  children: ReactNode;
}

// The grid and font steps are keyed to the total's length so a figure never breaks mid-number.
export function TotalAssetsHeader({ label, total, failed, children }: TotalAssetsHeaderProps) {
  const chars = total === null ? 0 : usd(total).length;
  return (
    <div className="@container">
      <div
        className={cn(
          'grid grid-cols-[minmax(0,1fr)] items-center gap-6',
          chars <= 11 && '@2xl:grid-cols-[auto_1px_1fr] @2xl:gap-10',
          chars > 11 && chars <= 13 && '@3xl:grid-cols-[auto_1px_1fr] @3xl:gap-10'
        )}
      >
        <div className="flex flex-col items-center gap-2 md:items-start">
          <span className="text-sm font-medium text-muted">{label}</span>
          <span
            className={cn(
              'leading-[1.1] font-bold whitespace-nowrap',
              chars <= 12 && 'text-6xl',
              chars > 12 && chars <= 15 && 'text-5xl @md:text-6xl',
              chars > 15 && 'text-4xl @md:text-5xl @2xl:text-6xl'
            )}
          >
            <Money value={total} failed={failed} />
          </span>
        </div>
        <Separator
          orientation="vertical"
          className={cn(
            'hidden h-full',
            chars <= 11 && '@2xl:block',
            chars > 11 && chars <= 13 && '@3xl:block'
          )}
        />
        <dl className="m-0 flex flex-col gap-5">{children}</dl>
      </div>
    </div>
  );
}

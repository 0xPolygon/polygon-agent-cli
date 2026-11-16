import { Skeleton } from '@polygonlabs/design-system';

import { usd } from '../utils/format.js';

interface MoneyProps {
  value: number | null;
  failed?: boolean;
  className?: string;
}

// `failed` shows a dash instead of a skeleton that would never resolve.
export function Money({ value, failed = false, className = '' }: MoneyProps) {
  if (value === null && failed) return <span className="text-slate-400">–</span>;
  return value === null ? (
    <Skeleton className="h-[1em] w-32" />
  ) : (
    <span className={className}>{usd(value)}</span>
  );
}

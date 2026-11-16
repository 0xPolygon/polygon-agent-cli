import type { ReactNode } from 'react';

import { Label, Select } from '@polygonlabs/design-system';

const AMOUNTS = [50, 100, 200, 500];
const OPTIONS = AMOUNTS.map((v) => ({ value: String(v), label: '$' + v.toLocaleString('en-US') }));

interface SpendingLimitsProps {
  limit: number;
  onChange: (limit: number) => void;
  children: ReactNode;
}

export function SpendingLimits({ limit, onChange, children }: SpendingLimitsProps) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col gap-3">
          <Label htmlFor="spending-limit" className="text-lg font-bold">
            Wallet spending limit
          </Label>
          <p className="m-0 text-sm font-medium text-muted">
            Your agents can only spend up to this amount. You approve every change from your email
            or browser.
          </p>
        </div>
        <Select.Helper
          id="spending-limit"
          options={OPTIONS}
          value={String(limit)}
          onValueChange={(v) => v !== null && onChange(Number(v))}
          className="w-full text-lg data-[size=default]:h-12 lg:w-50 lg:shrink-0"
        />
      </div>
      {children}
    </div>
  );
}

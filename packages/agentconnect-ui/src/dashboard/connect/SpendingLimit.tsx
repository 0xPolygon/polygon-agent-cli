import { Input, Label, Select } from '@polygonlabs/design-system';

import { AmountChips } from '../../components/AmountChips.js';
import { usd } from './usd.js';

const AMOUNTS = [100, 500, 1000, 5000];
const PERIODS = [7, 30];

interface SpendingLimitProps {
  spending: { minUsd: number; maxUsd: number; maxDays: number };
  allowanceUsd: number;
  days: number;
  busy: boolean;
  amountValid: boolean;
  setAllowanceUsd: (n: number) => void;
  setDays: (n: number) => void;
}

export function SpendingLimit({
  spending,
  allowanceUsd,
  days,
  busy,
  amountValid,
  setAllowanceUsd,
  setDays
}: SpendingLimitProps) {
  const periodOptions = PERIODS.filter((d) => d <= spending.maxDays).map((d) => ({
    value: String(d),
    label: `over ${d} days`
  }));
  return (
    <div className="flex flex-col gap-3">
      <span className="text-sm font-medium text-muted">Spending limit</span>
      <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
        <AmountChips values={AMOUNTS} value={allowanceUsd} onPick={setAllowanceUsd} />
      </fieldset>
      <div className="flex items-center gap-2.5">
        <Label htmlFor="allowance" className="sr-only">
          Other amount in US dollars
        </Label>
        <Input
          id="allowance"
          inputMode="numeric"
          autoComplete="on"
          value={String(allowanceUsd)}
          onChange={(e) => setAllowanceUsd(Number(e.target.value.replace(/[^0-9]/g, '')))}
          className="flex-1 text-base sm:text-sm"
        />
        <Label htmlFor="days" className="sr-only">
          Period
        </Label>
        <Select.Helper
          id="days"
          disabled={busy}
          options={periodOptions}
          value={String(days)}
          onValueChange={(v) => {
            const period = PERIODS.find((d) => String(d) === v);
            if (period !== undefined) setDays(period);
          }}
          className="shrink-0 text-base sm:text-sm"
        />
      </div>
      {!amountValid && (
        <span className="text-sm text-destructive">
          Choose between {usd(spending.minUsd)} and {usd(spending.maxUsd)}.
        </span>
      )}
    </div>
  );
}

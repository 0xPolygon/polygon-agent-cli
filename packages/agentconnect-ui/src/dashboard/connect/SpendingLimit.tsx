import { Input, Label } from '@polygonlabs/design-system';

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
        <select
          id="days"
          value={days}
          disabled={busy}
          onChange={(e) => setDays(Number(e.target.value))}
          className="h-10 rounded-xl border border-border-normal bg-background-input px-3 text-base font-medium text-primary outline-offset-2 outline-border-focus hover:not-disabled:border-border-hover focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm"
        >
          {PERIODS.filter((d) => d <= spending.maxDays).map((d) => (
            <option key={d} value={d}>
              over {d} days
            </option>
          ))}
        </select>
      </div>
      {!amountValid && (
        <span className="text-sm text-destructive">
          Choose between {usd(spending.minUsd)} and {usd(spending.maxUsd)}.
        </span>
      )}
    </div>
  );
}

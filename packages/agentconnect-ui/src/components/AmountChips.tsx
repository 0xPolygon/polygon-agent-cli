import { Button, cn } from '@polygonlabs/design-system';

interface AmountChipsProps {
  values: number[];
  value: number;
  onPick: (v: number) => void;
  format?: (v: number) => string;
}

const dollars = (v: number) => '$' + v.toLocaleString('en-US');

/** Option chips for amounts (top-up, limits). */
export function AmountChips({ values, value, onPick, format = dollars }: AmountChipsProps) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {values.map((v) => (
        <Button
          key={v}
          type="button"
          variant="secondary"
          size="lg"
          aria-pressed={v === value}
          onClick={() => onPick(v)}
          className={cn(
            'h-11 justify-center rounded-xl text-[15px]',
            v === value && 'border-primary bg-background-info hover:bg-background-info'
          )}
        >
          {format(v)}
        </Button>
      ))}
    </div>
  );
}

import { Button } from '@polygonlabs/design-system';

export type ActivityFilterValue = 'all' | 'in' | 'out';

interface ActivityFilterProps {
  value: ActivityFilterValue;
  onChange: (value: ActivityFilterValue) => void;
}

const OPTIONS: { id: ActivityFilterValue; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'in', label: 'Money in' },
  { id: 'out', label: 'Money out' }
];

export function ActivityFilter({ value, onChange }: ActivityFilterProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {OPTIONS.map(({ id, label }) => (
        <Button
          key={id}
          type="button"
          variant={value === id ? 'default' : 'secondary'}
          aria-pressed={value === id}
          onClick={() => onChange(id)}
          className="h-8 rounded-full px-3 text-sm"
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

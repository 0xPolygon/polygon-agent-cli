import { Spinner } from '@polygonlabs/design-system';

interface WaitingProps {
  text: string;
}

export function Waiting({ text }: WaitingProps) {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <Spinner size="xl" />
      <p className="m-0 text-sm text-muted">{text}</p>
    </div>
  );
}

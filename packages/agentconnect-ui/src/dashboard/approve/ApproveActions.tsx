import { Button } from '@polygonlabs/design-system';

interface ApproveActionsProps {
  busy: boolean;
  onDecide: (approve: boolean) => void;
}

export function ApproveActions({ busy, onDecide }: ApproveActionsProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Button
        type="button"
        variant="secondary"
        size="lg"
        disabled={busy}
        onClick={() => onDecide(false)}
        className="justify-center"
      >
        Decline
      </Button>
      <Button
        type="button"
        size="lg"
        disabled={busy}
        onClick={() => onDecide(true)}
        className="justify-center"
      >
        {busy ? 'Approving…' : 'Approve'}
      </Button>
    </div>
  );
}

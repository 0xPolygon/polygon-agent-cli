import type { ReactNode } from 'react';

import { Button } from '@polygonlabs/design-system';

interface ApproveResignProps {
  busy: boolean;
  onDecline: () => void;
  children: ReactNode;
}

export function ApproveResign({ busy, onDecline, children }: ApproveResignProps) {
  return (
    <div className="flex flex-col gap-3">
      <span className="text-base leading-snug text-muted">
        This runs from your wallet. Sign in again to approve it.
      </span>
      {children}
      <Button
        type="button"
        variant="secondary"
        size="lg"
        disabled={busy}
        onClick={onDecline}
        className="w-full justify-center"
      >
        Decline
      </Button>
    </div>
  );
}

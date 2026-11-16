import type { LucideIcon } from 'lucide-react';

import { Ban, CircleCheck, CircleX, Clock } from 'lucide-react';

import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@polygonlabs/design-system';

import type { Action } from '../Approve.js';

type Finished = Exclude<Action['status'], 'pending' | 'running'>;

const DONE: Record<Finished, string> = {
  done: 'Done.',
  failed: "Approved, but it didn't go through. Your agent has been told.",
  declined: 'Declined. Nothing was spent.',
  expired: 'This request expired. Nothing was spent.'
};

const LOOK: Record<Finished, { variant: 'success' | 'error' | 'neutral'; icon: LucideIcon }> = {
  done: { variant: 'success', icon: CircleCheck },
  failed: { variant: 'error', icon: CircleX },
  declined: { variant: 'neutral', icon: Ban },
  expired: { variant: 'neutral', icon: Clock }
};

interface ApproveResultProps {
  status: Finished;
  appName: string;
  failure?: string;
}

export function ApproveResult({ status, appName, failure }: ApproveResultProps) {
  const { variant, icon } = LOOK[status];
  return (
    <Alert variant={variant} size="sm" role={status === 'failed' ? 'alert' : 'status'}>
      <AlertIcon variant={variant} icon={icon} />
      <AlertTitle className="text-base">{DONE[status]}</AlertTitle>
      {(failure || status !== 'expired') && (
        <AlertDescription className="text-sm">
          {failure && <span className="block">{failure}</span>}
          {status !== 'expired' && (
            <span className="block">You can close this tab and go back to {appName}.</span>
          )}
        </AlertDescription>
      )}
    </Alert>
  );
}

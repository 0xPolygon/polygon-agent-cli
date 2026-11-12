import { Info } from 'lucide-react';

import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@polygonlabs/design-system';

interface ApproveRunningProps {
  appName: string;
}

export function ApproveRunning({ appName }: ApproveRunningProps) {
  return (
    <Alert variant="info" size="sm" role="status">
      <AlertIcon variant="info" icon={Info} />
      <AlertTitle className="text-base">Approved. Sending it now…</AlertTitle>
      <AlertDescription className="text-sm">
        You can go back to {appName}: it carries on by itself.
      </AlertDescription>
    </Alert>
  );
}

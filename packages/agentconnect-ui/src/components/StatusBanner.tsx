import { Info } from 'lucide-react';

import { Alert, AlertDescription, AlertIcon } from '@polygonlabs/design-system';

interface StatusBannerProps {
  children: React.ReactNode;
}

export function StatusBanner({ children }: StatusBannerProps) {
  return (
    <Alert variant="info" size="sm">
      <AlertIcon variant="info" icon={Info} />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

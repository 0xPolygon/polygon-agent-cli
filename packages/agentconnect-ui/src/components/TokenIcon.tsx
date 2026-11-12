import { useState } from 'react';

import { cn, TokenImage } from '@polygonlabs/design-system';

interface TokenIconProps {
  symbol: string;
  logo?: string;
  withChain?: boolean;
  className?: string;
}

// The badge is served from this app so no image host is added.
const CHAIN_BADGE = { src: '/chain-polygon.svg' };

export function TokenIcon({ symbol, logo, withChain = false, className }: TokenIconProps) {
  const [failedLogo, setFailedLogo] = useState<string>();
  // TokenImage has no error hook, so the failed load is caught as it bubbles through the React tree.
  return (
    <TokenImage
      src={logo === failedLogo ? undefined : logo}
      symbol={symbol}
      withNetwork={withChain ? CHAIN_BADGE : undefined}
      className={cn('size-6', className)}
      onError={() => setFailedLogo(logo)}
    />
  );
}

import { useState } from 'react';

import { cn, TokenImage } from '@polygonlabs/design-system';

interface TokenIconProps {
  symbol: string;
  logo?: string;
  chainId?: number;
  /** Letters are unreadable at small sizes, so a missing or failed logo gets a plain circle. */
  plainFallback?: boolean;
  className?: string;
}

const POLYGON_CHAIN_ID = 137;

// Served from this app so no image host is added; a chain without an entry gets no badge.
const CHAIN_BADGES: Record<number, { src: string }> = {
  [POLYGON_CHAIN_ID]: { src: '/chain-polygon.svg' }
};

export function TokenIcon({
  symbol,
  logo,
  chainId,
  plainFallback = false,
  className
}: TokenIconProps) {
  const [failedLogo, setFailedLogo] = useState<string>();
  // TokenImage has no error hook, so the failed load is caught as it bubbles through the React tree.
  const failed = logo === failedLogo;
  if (plainFallback && (!logo || failed)) {
    return <span aria-hidden className={cn('rounded-full bg-slate-200', className)} />;
  }
  return (
    <TokenImage
      src={failed ? undefined : logo}
      symbol={symbol}
      withNetwork={chainId === undefined ? undefined : CHAIN_BADGES[chainId]}
      className={cn('isolate size-6', className)}
      onError={() => setFailedLogo(logo)}
    />
  );
}

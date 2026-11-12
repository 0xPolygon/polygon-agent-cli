import { buttonVariants, cn } from '@polygonlabs/design-system';

import { LoginHeading } from './LoginHeading.js';

interface SignedInProps {
  walletAddress: string;
  dashboardHref: string;
  fundingUrl?: string;
}

export function SignedIn({ walletAddress, dashboardHref, fundingUrl }: SignedInProps) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <LoginHeading title="You're signed in">
        <p className="m-0 text-sm break-all text-muted">Wallet {walletAddress}</p>
        <p className="m-0 text-sm text-muted">
          {fundingUrl
            ? 'Your terminal session is ready. Your agent wallet is empty.'
            : 'Your terminal session is ready. Taking you to your dashboard.'}
        </p>
      </LoginHeading>
      {fundingUrl && (
        <a
          href={fundingUrl}
          className={cn(buttonVariants({ size: 'lg' }), 'mt-3 w-full justify-center')}
        >
          Add funds
        </a>
      )}
      <a href={dashboardHref} className={cn(buttonVariants({ variant: 'link' }), 'underline')}>
        {fundingUrl ? 'Open your dashboard' : 'Not redirected? Open your dashboard'}
      </a>
    </div>
  );
}

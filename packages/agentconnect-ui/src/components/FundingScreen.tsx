import { Fund } from '0xtrails/widget';
import { Check, Copy, Plus, X } from 'lucide-react';

import { Button } from '@polygonlabs/design-system';

import { trailsApiKey } from '../config';
import { useCopy } from '../hooks/useCopy.js';
import { shortAddr } from '../utils/format.js';

interface FundingScreenProps {
  walletAddress: string;
  chainId: number;
  // Target amount in USDC on Polygon, from the `amount` link parameter.
  amount?: string;
  onSkip: () => void;
}

const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

const trailsTheme: Record<string, string> = {
  '--trails-font-family': "'Fustat', 'Inter', ui-sans-serif, system-ui, sans-serif",

  '--trails-border-radius-widget': '24px',
  '--trails-border-radius-button': '12px',
  '--trails-border-radius-input': '12px',
  '--trails-border-radius-dropdown': '16px',
  '--trails-border-radius-container': '16px',
  '--trails-border-radius-list': '16px',

  '--trails-widget-border': '1px solid #c8cfe1',
  '--trails-shadow': '0 2px 8px rgba(20,22,53,0.06)',

  '--trails-primary': '#141635',
  '--trails-primary-hover': '#1e2155',
  '--trails-primary-disabled': '#929eba',
  '--trails-primary-disabled-text': 'rgba(255,255,255,0.5)',

  '--trails-bg-primary': '#ffffff',
  '--trails-bg-secondary': '#f5f6fb',
  '--trails-bg-tertiary': '#eef0f8',
  '--trails-bg-card': '#ffffff',

  '--trails-text-primary': '#141635',
  '--trails-text-secondary': '#64708f',
  '--trails-text-tertiary': '#64708f',
  '--trails-text-muted': '#929eba',

  '--trails-border-primary': '#c8cfe1',
  '--trails-border-secondary': '#c8cfe1',
  '--trails-border-tertiary': '#eef0f8',

  '--trails-hover-bg': '#f5f6fb',
  '--trails-focus-ring': 'rgba(124,58,237,0.15)',

  '--trails-input-bg': '#f5f6fb',
  '--trails-input-border': '#c8cfe1',
  '--trails-input-text': '#141635',
  '--trails-input-placeholder': '#929eba',
  '--trails-input-focus-border': '#7c3aed',
  '--trails-input-focus-ring': 'rgba(124,58,237,0.12)',

  '--trails-dropdown-bg': '#ffffff',
  '--trails-dropdown-border': '#c8cfe1',
  '--trails-dropdown-text': '#141635',
  '--trails-dropdown-hover-bg': '#f5f6fb',
  '--trails-dropdown-selected-bg': '#f5f6fb',
  '--trails-dropdown-selected-text': '#141635',

  '--trails-list-bg': '#ffffff',
  '--trails-list-border': '#c8cfe1',
  '--trails-list-hover-bg': '#f5f6fb'
};

// The `amount` link parameter as a positive decimal string, or undefined.
export function parseFundAmount(raw: string | null | undefined): string | undefined {
  if (!raw || !/^\d+(\.\d+)?$/.test(raw)) return undefined;
  return Number(raw) > 0 ? raw : undefined;
}

export function FundingScreen({ walletAddress, chainId, amount, onSkip }: FundingScreenProps) {
  const [copied, copy] = useCopy();
  return (
    <div className="relative w-full max-w-[400px] rounded-3xl border border-border-normal bg-background-primary shadow-lg">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        iconOnly
        aria-label="Close"
        onClick={onSkip}
        className="absolute right-4 top-4"
      >
        <X className="size-4" />
      </Button>
      <div className="flex min-w-0 flex-col gap-5 px-4 pb-4 pt-6 sm:px-6 sm:pb-6">
        <div className="flex flex-col items-center gap-1 pt-1 text-center">
          <Plus aria-hidden="true" className="size-8 stroke-1 text-link" />
          <h2 className="text-[28px] font-bold leading-[1.2] text-primary">
            Fund your agent wallet
          </h2>
          <p className="text-base font-bold leading-snug text-muted">
            Deposit funds with a wallet, credit card, or exchange to access paid services.
          </p>
        </div>

        {/* Keep the Trails widget inside the card width on narrow screens. */}
        <div className="w-full min-w-0 max-w-full [&>*]:max-w-full">
          <Fund
            apiKey={trailsApiKey}
            theme="light"
            customCss={trailsTheme}
            to={{
              recipient: walletAddress,
              token: USDC_POLYGON,
              chain: chainId
            }}
            // The widget's destination amount (toAmount) is not in the Fund prop types, but
            // Fund passes unknown props through to it.
            {...(amount ? { toAmount: amount } : {})}
            buttonText="Add Funds to Agent"
            hideSwap={true}
            onramp={{
              mesh: {
                environment: 'production'
              }
            }}
            onDestinationConfirmation={({ txHash, chainId: confirmChainId, sessionId }) => {
              console.log('onDestinationConfirmation:', {
                txHash,
                chainId: confirmChainId,
                sessionId
              });
              setTimeout(onSkip, 3000);
            }}
          />
        </div>

        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="font-medium text-muted">Or send on Polygon to</span>
          <button
            type="button"
            onClick={() => copy('address', walletAddress)}
            aria-label={copied ? 'Address copied' : 'Copy wallet address'}
            title={walletAddress}
            className="inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 font-mono text-[13px] text-primary transition-colors hover:text-link"
          >
            {shortAddr(walletAddress)}
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
        </div>

        <Button type="button" variant="ghost" onClick={onSkip} className="w-full justify-center">
          Skip for now
        </Button>
      </div>
    </div>
  );
}

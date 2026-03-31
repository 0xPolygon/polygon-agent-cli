import { TrailsWidget } from '0xtrails/widget';

import { trailsApiKey } from '../config';

interface FundingScreenProps {
  walletAddress: string;
  chainId: number;
  onSkip: () => void;
}

const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

const trailsTheme: Record<string, string> = {
  '--trails-font-family': 'ui-sans-serif, system-ui, sans-serif',

  '--trails-border-radius-widget': '16px',
  '--trails-border-radius-button': '12px',
  '--trails-border-radius-input': '12px',
  '--trails-border-radius-dropdown': '12px',
  '--trails-border-radius-container': '12px',
  '--trails-border-radius-list': '12px',

  '--trails-widget-border': '1px solid #e5e5f0',
  '--trails-shadow': '0 4px 24px rgba(130,71,229,0.08)',

  '--trails-primary': '#8247e5',
  '--trails-primary-hover': '#7139d4',
  '--trails-primary-disabled': '#c4b4f5',
  '--trails-primary-disabled-text': 'rgba(255,255,255,0.5)',

  '--trails-bg-primary': '#ffffff',
  '--trails-bg-secondary': '#f3f4f8',
  '--trails-bg-tertiary': '#eeeef5',
  '--trails-bg-card': '#ffffff',

  '--trails-text-primary': '#0f0f1a',
  '--trails-text-secondary': '#374151',
  '--trails-text-tertiary': '#6b7280',
  '--trails-text-muted': '#9ca3af',

  '--trails-border-primary': '#e5e5f0',
  '--trails-border-secondary': '#e5e5f0',
  '--trails-border-tertiary': '#f0f0f5',

  '--trails-hover-bg': '#f3f4f8',
  '--trails-focus-ring': 'rgba(130,71,229,0.2)',

  '--trails-input-bg': '#f3f4f8',
  '--trails-input-border': '#e5e5f0',
  '--trails-input-text': '#0f0f1a',
  '--trails-input-placeholder': '#9ca3af',
  '--trails-input-focus-border': '#8247e5',
  '--trails-input-focus-ring': 'rgba(130,71,229,0.15)',

  '--trails-dropdown-bg': '#ffffff',
  '--trails-dropdown-border': '#e5e5f0',
  '--trails-dropdown-text': '#374151',
  '--trails-dropdown-hover-bg': '#f3f4f8',
  '--trails-dropdown-selected-bg': '#f3f4f8',
  '--trails-dropdown-selected-text': '#0f0f1a',

  '--trails-list-bg': '#ffffff',
  '--trails-list-border': '#e5e5f0',
  '--trails-list-hover-bg': '#f9f9fc'
};

export function FundingScreen({ walletAddress, chainId, onSkip }: FundingScreenProps) {
  return (
    <div className="w-full max-w-sm animate-scale-in">
      {/* Card */}
      <div
        className="w-full bg-white rounded-2xl border border-[#e5e5f0] overflow-hidden"
        style={{ boxShadow: '0 2px 4px rgba(0,0,0,0.04), 0 12px 40px rgba(130,71,229,0.09)' }}
      >
        {/* Purple hairline */}
        <div className="h-0.5 bg-gradient-to-r from-[#8247e5] via-[#a855f7] to-[#8247e5]" />

        <div className="px-6 pt-7 pb-6 flex flex-col gap-5">
          {/* Headline + subtext */}
          <div>
            <h2 className="text-[#0f0f1a] font-semibold text-base leading-snug mb-1">
              Fund your agent wallet
            </h2>
            <p className="text-[#6b7280] text-sm leading-relaxed">
              Deposit funds with a wallet, credit card, or exchange to access paid services.
            </p>
          </div>

          {/* Trails widget renders its own styled button */}
          <TrailsWidget
            apiKey={trailsApiKey}
            mode="fund"
            theme="light"
            customCss={trailsTheme}
            toChainId={chainId}
            toToken={USDC_POLYGON}
            toAddress={walletAddress}
            buttonText="Add Funds to Agent"
            fundOptions={{ fiatAmount: '20', hideSwap: true }}
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
      </div>

      <button
        onClick={onSkip}
        className="mt-4 w-full text-sm text-[#9ca3af] hover:text-[#6b7280] transition-colors cursor-pointer border-0 bg-transparent py-1"
      >
        Skip for now
      </button>
    </div>
  );
}

import { Fund } from '0xtrails/widget';

import { trailsApiKey } from '../config';

interface FundingScreenProps {
  walletAddress: string;
  chainId: number;
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

export function FundingScreen({ walletAddress, chainId, onSkip }: FundingScreenProps) {
  return (
    <div className="w-full max-w-sm animate-scale-in">
      {/* Card */}
      <div
        className="w-full bg-white rounded-3xl border border-[#c8cfe1] overflow-hidden"
        style={{ boxShadow: '0 2px 8px rgba(20,22,53,0.06), 0 16px 48px rgba(20,22,53,0.08)' }}
      >
        <div className="px-6 pt-7 pb-6 flex flex-col gap-5">
          {/* Headline + subtext */}
          <div>
            <h2 className="text-[#141635] font-bold text-lg leading-snug mb-1">
              Fund your agent wallet
            </h2>
            <p className="text-[#64708f] text-sm font-medium leading-relaxed">
              Deposit funds with a wallet, credit card, or exchange to access paid services.
            </p>
          </div>

          <Fund
            apiKey={trailsApiKey}
            theme="light"
            customCss={trailsTheme}
            to={{
              recipient: walletAddress,
              currency: USDC_POLYGON,
              chain: chainId
            }}
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
      </div>

      <button
        onClick={onSkip}
        className="mt-4 w-full text-sm text-[#929eba] hover:text-[#64708f] font-medium transition-colors cursor-pointer border-0 bg-transparent py-1"
      >
        Skip for now
      </button>
    </div>
  );
}

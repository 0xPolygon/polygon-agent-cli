import './oms.css';
import './App.css';

import { useMemo } from 'react';

import { parseFundAmount } from './components/FundingScreen.js';
import { Dashboard } from './dashboard/Dashboard.js';
import { Onboarding } from './dashboard/Onboarding.js';
import { isWebSigninReturn } from './dashboard/signin.js';
import { LoginPage } from './login/LoginPage.js';
import { isRelayReturn } from './login/returnUrl.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// Shared logo header used on every screen.
export function LogoBadge() {
  return (
    <div className="flex items-center gap-2 flex-shrink-0">
      <img src="/logo-mark.svg" alt="" className="w-[26px] h-[26px]" />
      <span className="font-bold text-[19px] text-[var(--slate-900)]">polygon</span>
      <span className="oms-mono text-[11px] bg-[var(--slate-900)] text-white px-[7px] py-[3px] rounded-md whitespace-nowrap">
        &gt;_ agent
      </span>
    </div>
  );
}

// ── Main App ──
function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const walletAddress = params.get('wallet') || '';
  const chainId = Number(params.get('chain') || '137');
  // The Polymarket trading account, when the CLI knows it; positions live there.
  const pm = params.get('pm') ?? '';

  if (window.location.pathname === '/login') {
    // A Google sign-in started on the onboarding page comes back here too.
    if (isWebSigninReturn() && isRelayReturn(window.location.search)) {
      return <Onboarding finishing />;
    }
    return <LoginPage />;
  }

  if (!walletAddress) {
    return <Onboarding />;
  }

  // `?view=fund` (the CLI's `fund` deep link) opens the dashboard with the
  // funding widget already popped up, rather than a separate page.
  return (
    <Dashboard
      walletAddress={walletAddress}
      chainId={chainId}
      polymarketAddress={ADDRESS.test(pm) ? pm : undefined}
      initialFundOpen={params.get('view') === 'fund'}
      fundAmount={parseFundAmount(params.get('amount'))}
    />
  );
}

export { App };

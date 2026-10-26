import './oms.css';
import './App.css';

import { useEffect, useMemo, useState } from 'react';

import type { Session } from './dashboard/signin.js';

import { parseFundAmount } from './components/FundingScreen.js';
import { Approve, isApproveReturn } from './dashboard/Approve.js';
import { Connect, isConnectReturn } from './dashboard/Connect.js';
import { Dashboard } from './dashboard/Dashboard.js';
import { Onboarding } from './dashboard/Onboarding.js';
import { currentSession, isWebSigninReturn } from './dashboard/signin.js';
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

// Who is signed in here; undefined while asking.
function useSession(): Session | null | undefined {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    void currentSession().then(setSession);
  }, []);
  return session;
}

// ── Main App ──
function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const walletAddress = params.get('wallet') || '';
  const chainId = Number(params.get('chain') || '137');
  // The Polymarket trading account, when the CLI knows it; positions live there.
  const pm = params.get('pm') ?? '';

  if (window.location.pathname === '/connect') {
    return <Connect />;
  }

  if (window.location.pathname === '/approve') {
    return <Approve />;
  }

  if (window.location.pathname === '/login') {
    // Google sign-ins started here (connecting an agent, onboarding) come back
    // to /login too.
    if (isConnectReturn() && isRelayReturn(window.location.search)) {
      return <Connect finishing />;
    }
    if (isApproveReturn() && isRelayReturn(window.location.search)) {
      return <Approve finishing />;
    }
    if (isWebSigninReturn() && isRelayReturn(window.location.search)) {
      return <Onboarding finishing />;
    }
    return <LoginPage />;
  }

  return <Home walletAddress={walletAddress} chainId={chainId} pm={pm} params={params} />;
}

// The site itself: the dashboard for whoever is signed in (or the wallet an
// agent's link names), else sign-in and onboarding.
function Home({
  walletAddress,
  chainId,
  pm,
  params
}: {
  walletAddress: string;
  chainId: number;
  pm: string;
  params: URLSearchParams;
}) {
  const session = useSession();
  if (session === undefined) {
    return <div className="min-h-[100dvh] bg-[var(--slate-50)]" />;
  }

  const wallet = walletAddress || session?.wallet;
  if (!wallet) {
    return <Onboarding />;
  }

  // `?view=fund` (the CLI's `fund` deep link) opens the dashboard with the
  // funding widget already popped up, rather than a separate page.
  return (
    <Dashboard
      walletAddress={wallet}
      chainId={chainId}
      polymarketAddress={ADDRESS.test(pm) ? pm : undefined}
      initialFundOpen={params.get('view') === 'fund'}
      fundAmount={parseFundAmount(params.get('amount'))}
      session={session}
    />
  );
}

export { App };

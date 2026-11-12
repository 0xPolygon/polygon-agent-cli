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
    <div className="flex shrink-0 items-end gap-[9px]">
      <img src="/logo-mark.svg" alt="" className="h-5 w-auto" />
      <span className="text-[19px] font-bold leading-none text-primary">polygon</span>
      <span className="flex h-5 items-center rounded bg-slate-900 px-3 text-xs font-medium leading-none whitespace-nowrap text-white">
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
    return <div className="min-h-[100dvh] bg-background-primary" />;
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

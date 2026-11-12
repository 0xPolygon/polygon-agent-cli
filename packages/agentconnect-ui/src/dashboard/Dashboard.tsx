import { useEffect, useRef, useState } from 'react';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogPrimitive,
  DialogTitle,
  SidebarProvider,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useMediaQuery,
  useToast
} from '@polygonlabs/design-system';

import type { ActivityItem, Holding } from '../indexer';
import type { Page } from './AppSidebar.js';
import type { Vault } from './earn.js';
import type { Position } from './markets.js';
import type { Session } from './signin.js';
import type { AgentContext, Loadable } from './tabs.js';

import { AgentPromptBox } from '../components/AgentPromptBox.js';
import { AmountChips } from '../components/AmountChips.js';
import { FundingScreen } from '../components/FundingScreen.js';
import { useCopy } from '../hooks/useCopy.js';
import { fetchActivity, fetchHoldings } from '../indexer';
import { usd } from '../utils/format.js';
import { rememberedEmail } from './account.js';
import { SKILL_URL } from './agents.js';
import { AppSidebar } from './AppSidebar.js';
import { ConnectedAgents } from './ConnectedAgents.js';
import { fetchPolygonRates, fetchVaultBalances, fetchVaults } from './earn.js';
import { fetchPositions, fetchPredictionCash } from './markets.js';
import { ProfileMenu } from './ProfileMenu.js';
import { signOut } from './signin.js';
import {
  ActivityTab,
  AskAgent,
  EarnTab,
  MarketsTab,
  OVERVIEW_PROMPTS,
  OverviewTab,
  SettingsTab,
  WALLET_PROMPTS,
  WalletTab
} from './tabs.js';
import { TopBar } from './TopBar.js';

type OverviewSection = 'tokens' | 'history' | 'agents';

function isOverviewSection(v: unknown): v is OverviewSection {
  return v === 'tokens' || v === 'history' || v === 'agents';
}

// Tab components navigate with these ids.
const LEGACY_TARGETS: Record<string, { page: Page; section?: OverviewSection }> = {
  overview: { page: 'overview' },
  wallet: { page: 'overview', section: 'tokens' },
  activity: { page: 'overview', section: 'history' },
  markets: { page: 'markets' },
  earn: { page: 'yield' },
  settings: { page: 'settings' }
};

function useLoad<T>(load: (() => Promise<T>) | null, deps: unknown[]): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ data: null, loading: !!load, error: false });
  useEffect(() => {
    if (!load) {
      setState({ data: null, loading: false, error: false });
      return;
    }
    let active = true;
    setState({ data: null, loading: true, error: false });
    load()
      .then((data) => active && setState({ data, loading: false, error: false }))
      .catch((err) => {
        console.warn(err);
        if (active) setState({ data: null, loading: false, error: true });
      });
    return () => {
      active = false;
    };
  }, deps);
  return state;
}

type ModalState = { kind: 'add' } | { kind: 'withdraw' } | { kind: 'deposit'; vault: Vault };

export function Dashboard({
  walletAddress,
  chainId,
  polymarketAddress,
  initialFundOpen,
  fundAmount,
  session
}: {
  walletAddress: string;
  chainId: number;
  polymarketAddress?: string;
  initialFundOpen: boolean;
  fundAmount?: string;
  // The owner signed in on this site, if anyone.
  session: Session | null;
}) {
  const [page, setPage] = useState<Page>('overview');
  const [section, setSection] = useState<OverviewSection>('tokens');
  // The tab row sits below the fold; links that pick a tab would look dead without a scroll.
  const [revealTabs, setRevealTabs] = useState(false);
  const tabsRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [modal, setModal] = useState<ModalState | null>(initialFundOpen ? { kind: 'add' } : null);
  const [copied, copy] = useCopy();
  const toast = useToast();
  const owner = session?.wallet === walletAddress.toLowerCase() ? session : null;
  const [email] = useState(() => owner?.email ?? rememberedEmail(walletAddress));
  const leave = () => void signOut().then(() => window.location.assign('/'));

  const holdings = useLoad<Holding[]>(
    () => fetchHoldings(walletAddress, chainId),
    [walletAddress, chainId]
  );
  const activity = useLoad<ActivityItem[]>(
    () => fetchActivity(walletAddress, chainId),
    [walletAddress, chainId]
  );
  const positions = useLoad<Position[]>(
    polymarketAddress ? () => fetchPositions(polymarketAddress) : null,
    [polymarketAddress]
  );
  const predictionCash = useLoad<number>(
    polymarketAddress ? () => fetchPredictionCash(polymarketAddress) : null,
    [polymarketAddress]
  );
  const vaults = useLoad<Vault[]>(fetchVaults, []);
  const vaultBalances = useLoad<Record<string, number>>(
    vaults.data ? () => fetchVaultBalances(walletAddress, vaults.data!) : null,
    [walletAddress, vaults.data]
  );
  const polygonRates = useLoad<Record<string, number>>(fetchPolygonRates, []);
  const vaultsValue = vaultBalances.data
    ? Object.values(vaultBalances.data).reduce((s, v) => s + v, 0)
    : null;

  useEffect(() => {
    if (copied)
      toast.add({ title: 'Copied. Paste it into your agent.', type: 'success', timeout: 2200 });
  }, [copied]);

  useEffect(() => {
    if (!revealTabs) return;
    tabsRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    setRevealTabs(false);
  }, [revealTabs, reduceMotion]);

  const ctx: AgentContext = { copied, copy };
  const go = (target: string) => {
    const next = LEGACY_TARGETS[target];
    if (!next) return;
    setPage(next.page);
    if (next.section) {
      setSection(next.section);
      setRevealTabs(true);
    }
  };
  // Open positions plus pUSD waiting in the trading account.
  const positionsValue = positions.data
    ? positions.data.reduce((s, p) => s + p.value, 0) + (predictionCash.data ?? 0)
    : null;
  // Everything the wallet holds, as on Overview: Polygon, predictions, Katana vaults.
  const totalBalance = holdings.data
    ? holdings.data.reduce((t, h) => t + h.usd, 0) + (positionsValue ?? 0) + (vaultsValue ?? 0)
    : null;
  // What the earning money makes, weighted by how much sits in each place.
  const earningApy = (() => {
    if (!holdings.data || !polygonRates.data) return null;
    const parts: [number, number | undefined][] = [
      ...holdings.data
        .filter((h) => h.kind === 'earn')
        .map((h): [number, number | undefined] => [h.usd, polygonRates.data![h.address]]),
      ...(vaults.data ?? []).map((v): [number, number | undefined] => [
        vaultBalances.data?.[v.address] ?? 0,
        v.apy
      ])
    ];
    const priced = parts.filter(([u, apy]) => u > 0 && apy !== undefined) as [number, number][];
    const total = priced.reduce((t, [u]) => t + u, 0);
    return total > 0 ? priced.reduce((t, [u, apy]) => t + u * apy, 0) / total : null;
  })();
  const openAdd = () => setModal({ kind: 'add' });
  const openWithdraw = () => setModal({ kind: 'withdraw' });

  return (
    <SidebarProvider className="[--sidebar-width:15rem]! h-[100dvh] flex-col overflow-hidden bg-background-primary text-primary">
      <TopBar
        profile={
          <ProfileMenu
            label={email ?? 'Your wallet'}
            balance={totalBalance === null ? '…' : usd(totalBalance)}
            onSettings={() => setPage('settings')}
            onSignOut={owner ? leave : undefined}
          />
        }
      />
      <div className="flex min-h-0 flex-1">
        <AppSidebar page={page} onNavigate={setPage} />
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[800px] flex-col gap-8 px-4 pb-12 pt-6 md:px-0 md:pt-12">
            {page === 'overview' && (
              <>
                <OverviewTab
                  holdings={holdings}
                  activity={activity}
                  positionsValue={positionsValue}
                  vaultsValue={vaultsValue}
                  earningApy={earningApy}
                  go={go}
                  onAdd={openAdd}
                  onWithdraw={openWithdraw}
                />
                <AskAgent ctx={ctx} id="o" prompts={OVERVIEW_PROMPTS} title="Try with your agent" />
                <div ref={tabsRef} className="scroll-mt-4">
                  <Tabs
                    value={section === 'agents' && !owner ? 'tokens' : section}
                    onValueChange={(v) => isOverviewSection(v) && setSection(v)}
                  >
                    <TabsList>
                      <TabsTrigger value="tokens">Tokens</TabsTrigger>
                      <TabsTrigger value="history">Activity</TabsTrigger>
                      {owner && <TabsTrigger value="agents">Connected agents</TabsTrigger>}
                    </TabsList>
                    <TabsContent value="tokens" className="flex flex-col gap-8 pt-6">
                      <WalletTab
                        address={walletAddress}
                        holdings={holdings}
                        onAdd={openAdd}
                        onWithdraw={openWithdraw}
                      />
                      <AskAgent ctx={ctx} id="w" prompts={WALLET_PROMPTS} />
                    </TabsContent>
                    <TabsContent value="history" className="pt-6">
                      <ActivityTab activity={activity} />
                    </TabsContent>
                    {owner && (
                      <TabsContent value="agents" className="pt-6">
                        <ConnectedAgents />
                      </TabsContent>
                    )}
                  </Tabs>
                </div>
              </>
            )}
            {page === 'markets' && (
              <MarketsTab
                positions={positions}
                cash={predictionCash}
                hasAccount={!!polymarketAddress}
                ctx={ctx}
              />
            )}
            {page === 'yield' && (
              <EarnTab
                holdings={holdings}
                vaults={vaults}
                vaultBalances={vaultBalances}
                ctx={ctx}
                onDeposit={(vault) => setModal({ kind: 'deposit', vault })}
              />
            )}
            {page === 'settings' && <SettingsTab address={walletAddress} ctx={ctx} />}
            {page === 'settings' && owner && (
              <Button
                type="button"
                variant="secondary"
                size="lg"
                onClick={leave}
                className="self-start"
              >
                Sign out
              </Button>
            )}
          </div>
        </main>
      </div>

      {modal?.kind === 'add' && (
        <Dialog open onOpenChange={(open) => !open && setModal(null)}>
          <DialogPortal>
            <DialogOverlay />
            {/* No transform or overflow on the popup: the funding widget draws full-screen
                layers that a transformed or clipping ancestor would confine to this box. */}
            <DialogPrimitive.Popup className="fixed inset-0 m-auto h-fit w-full max-w-[calc(100%-2rem)] sm:max-w-sm outline-none">
              <DialogTitle className="sr-only">Fund your agent wallet</DialogTitle>
              <FundingScreen
                walletAddress={walletAddress}
                chainId={chainId}
                amount={fundAmount}
                onSkip={() => setModal(null)}
              />
            </DialogPrimitive.Popup>
          </DialogPortal>
        </Dialog>
      )}
      {modal?.kind === 'withdraw' && <WithdrawModal ctx={ctx} onClose={() => setModal(null)} />}
      {modal?.kind === 'deposit' && (
        <DepositModal
          vault={modal.vault}
          available={
            holdings.data?.find(
              (h) => h.kind === 'spend' && h.symbol.toUpperCase() === modal.vault.symbol
            )?.usd ?? null
          }
          ctx={ctx}
          onClose={() => setModal(null)}
        />
      )}
    </SidebarProvider>
  );
}

// Money only moves through the agent (the wallet's key lives with the CLI), so
// these modals hand the user a ready prompt rather than signing in the browser.

function WithdrawModal({ ctx, onClose }: { ctx: AgentContext; onClose: () => void }) {
  const [amount, setAmount] = useState(50);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent responsive className="sm:max-w-[420px] gap-5">
        <DialogHeader className="pr-8 text-left">
          <DialogTitle className="text-[22px]">Withdraw</DialogTitle>
          <DialogDescription>
            Ask your agent to send money back to you. You confirm the request from your email or
            browser.
          </DialogDescription>
        </DialogHeader>
        <AmountChips values={[25, 50, 100, 250]} value={amount} onPick={setAmount} />
        <AgentPromptBox
          {...ctx}
          id="withdraw"
          skill={SKILL_URL}
          text={`withdraw ${amount} USDC from my agent wallet to my own wallet. Ask me which address to send it to.`}
        />
      </DialogContent>
    </Dialog>
  );
}

function DepositModal({
  vault,
  available,
  ctx,
  onClose
}: {
  vault: Vault;
  available: number | null;
  ctx: AgentContext;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState(100);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent responsive className="sm:max-w-[420px] gap-5">
        <DialogHeader className="pr-8 text-left">
          <DialogTitle className="text-[22px]">{`Deposit into ${vault.tier.name}`}</DialogTitle>
          <DialogDescription>
            {available === null
              ? `Your agent moves ${vault.symbol} from your balance into the ${vault.tier.name} vault.`
              : `From your available ${vault.symbol} balance of ${usd(available)}.`}
          </DialogDescription>
        </DialogHeader>
        <AmountChips values={[25, 50, 100, 250]} value={amount} onPick={setAmount} />
        <div className="bg-background-muted rounded-xl px-4 py-3.5 flex flex-col gap-2 text-sm">
          <span className="flex justify-between">
            <span className="text-slate-600">Rate</span>
            <span className="font-bold">{vault.apy.toFixed(2)}% a year</span>
          </span>
          <span className="flex justify-between">
            <span className="text-slate-600">Estimated in 1 year</span>
            <span className="font-bold text-success">+{usd((amount * vault.apy) / 100)}</span>
          </span>
          <span className="flex justify-between">
            <span className="text-slate-600">Risk</span>
            <span className="font-bold">{vault.tier.risk}</span>
          </span>
          <span className="flex justify-between">
            <span className="text-slate-600">Withdraw</span>
            <span className="font-bold">Anytime</span>
          </span>
        </div>
        <AgentPromptBox
          {...ctx}
          id="deposit"
          skill={SKILL_URL}
          text={`deposit ${amount} ${vault.symbol} into the ${vault.tier.name} earn vault on Katana (vault ${vault.address}). Bridge the ${vault.symbol} from Polygon to Katana first if needed, then report the rate.`}
        />
      </DialogContent>
    </Dialog>
  );
}

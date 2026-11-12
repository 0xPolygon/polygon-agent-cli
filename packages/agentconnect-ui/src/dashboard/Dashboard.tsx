import type { ElementType } from 'react';

import {
  Activity,
  LayoutGrid,
  Menu,
  PiggyBank,
  Plus,
  Settings,
  TrendingUp,
  Wallet
} from 'lucide-react';
import { useEffect, useState } from 'react';

import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogPrimitive,
  DialogTitle,
  useToast
} from '@polygonlabs/design-system';

import type { ActivityItem, Holding } from '../indexer';
import type { Vault } from './earn.js';
import type { Position } from './markets.js';
import type { Session } from './signin.js';
import type { AgentContext, Loadable } from './tabs.js';

import { LogoBadge } from '../App.js';
import { AgentPromptBox } from '../components/AgentPromptBox.js';
import { AmountChips } from '../components/AmountChips.js';
import { FundingScreen } from '../components/FundingScreen.js';
import { useCopy } from '../hooks/useCopy.js';
import { fetchActivity, fetchHoldings } from '../indexer';
import { usd } from '../utils/format.js';
import { rememberedEmail } from './account.js';
import { SKILL_URL } from './agents.js';
import { ConnectedAgents } from './ConnectedAgents.js';
import { fetchPolygonRates, fetchVaultBalances, fetchVaults } from './earn.js';
import { fetchPositions, fetchPredictionCash } from './markets.js';
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

type Tab = 'overview' | 'wallet' | 'markets' | 'earn' | 'activity' | 'settings';

const NAV: { id: Tab; label: string; icon: ElementType }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutGrid },
  { id: 'wallet', label: 'Wallet', icon: Wallet },
  { id: 'markets', label: 'Markets', icon: TrendingUp },
  { id: 'earn', label: 'Earn', icon: PiggyBank },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'settings', label: 'Settings', icon: Settings }
];
// Phones show the first four in the tab bar and the rest under More.
const MOBILE_PRIMARY = 4;

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
  const [tab, setTab] = useState<Tab>('overview');
  const [moreOpen, setMoreOpen] = useState(false);
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

  const ctx: AgentContext = { copied, copy };
  const go = (t: string) => {
    setTab(t as Tab);
    setMoreOpen(false);
  };
  const title = NAV.find((n) => n.id === tab)!.label;
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
    <div className="h-[100dvh] flex bg-background-muted text-primary overflow-hidden">
      {/* Sidebar (tablet and up) */}
      <aside className="hidden md:flex w-60 flex-shrink-0 bg-white border-r border-slate-200 flex-col px-3 py-5">
        <div className="px-2 pb-6">
          <LogoBadge />
        </div>
        <nav className="flex flex-col gap-0.5" aria-label="Main">
          {NAV.map((n) => {
            const on = n.id === tab;
            const Icon = n.icon;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => go(n.id)}
                aria-current={on ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-3 h-10 px-3 rounded-[10px] border-0 text-[15px] text-left cursor-pointer transition-colors',
                  on
                    ? 'bg-background-info text-info font-bold'
                    : 'bg-transparent text-slate-600 font-medium hover:bg-background-muted'
                )}
              >
                <Icon className="w-[18px] h-[18px]" />
                {n.label}
              </button>
            );
          })}
        </nav>
        <div className="flex-1" />
        <div className="flex items-center gap-2.5 p-3 border-t border-slate-100">
          <span className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-purple-300 flex-shrink-0" />
          <span className="flex flex-col gap-0.5 min-w-0">
            <span className="text-sm font-bold truncate max-w-[140px]">
              {email ?? 'Your wallet'}
            </span>
            <span className="text-xs text-muted">
              {totalBalance === null ? '…' : usd(totalBalance)}
            </span>
          </span>
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Phone top bar */}
        <div className="md:hidden h-14 flex-shrink-0 flex items-center justify-between px-4 bg-white border-b border-slate-200">
          <div className="flex items-center gap-2">
            <img src="/logo-mark.svg" alt="" className="w-6 h-6" />
            <span className="font-bold text-[17px]">{title}</span>
          </div>
          {email && <span className="text-xs text-muted truncate max-w-[50%]">{email}</span>}
        </div>

        <main className="flex-1 overflow-y-auto">
          <div className="max-w-[1000px] mx-auto px-4 pt-5 pb-8 md:px-10 md:pt-9 md:pb-12 flex flex-col gap-8">
            <div className="hidden md:flex justify-between items-center gap-4">
              <h1 className="m-0 text-[28px] font-bold">{title}</h1>
              <Button type="button" size="lg" onClick={openAdd}>
                <Plus />
                Add money
              </Button>
            </div>

            {tab === 'overview' && (
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
            )}
            {tab === 'overview' && (
              <AskAgent ctx={ctx} id="o" prompts={OVERVIEW_PROMPTS} title="Try with your agent" />
            )}
            {tab === 'wallet' && (
              <WalletTab
                address={walletAddress}
                holdings={holdings}
                onAdd={openAdd}
                onWithdraw={openWithdraw}
              />
            )}
            {tab === 'wallet' && <AskAgent ctx={ctx} id="w" prompts={WALLET_PROMPTS} />}
            {tab === 'markets' && (
              <MarketsTab
                positions={positions}
                cash={predictionCash}
                hasAccount={!!polymarketAddress}
                ctx={ctx}
              />
            )}
            {tab === 'earn' && (
              <EarnTab
                holdings={holdings}
                vaults={vaults}
                vaultBalances={vaultBalances}
                ctx={ctx}
                onDeposit={(vault) => setModal({ kind: 'deposit', vault })}
              />
            )}
            {tab === 'activity' && <ActivityTab activity={activity} />}
            {tab === 'settings' && owner && <ConnectedAgents />}
            {tab === 'settings' && <SettingsTab address={walletAddress} ctx={ctx} />}
            {tab === 'settings' && owner && (
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

            <div className="text-center text-[13px] text-slate-400 pt-2">Powered by Polygon</div>
          </div>
        </main>

        {/* Phone tab bar */}
        <nav
          className="md:hidden flex-shrink-0 grid grid-cols-5 bg-white border-t border-slate-200 px-1 pt-1.5 pb-3.5"
          aria-label="Main"
        >
          {[
            ...NAV.slice(0, MOBILE_PRIMARY),
            { id: 'more' as const, label: 'More', icon: Menu }
          ].map((n) => {
            const on =
              n.id === 'more' ? NAV.slice(MOBILE_PRIMARY).some((m) => m.id === tab) : n.id === tab;
            const Icon = n.icon;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => (n.id === 'more' ? setMoreOpen(true) : go(n.id))}
                className={cn(
                  'flex flex-col items-center justify-center gap-1 h-[52px] border-0 bg-transparent text-[11px] font-bold cursor-pointer',
                  on ? 'text-brand' : 'text-muted'
                )}
              >
                <Icon className="w-[22px] h-[22px]" />
                {n.id === 'overview' ? 'Home' : n.label}
              </button>
            );
          })}
        </nav>
      </div>

      {moreOpen && (
        <div
          onClick={() => setMoreOpen(false)}
          className="md:hidden fixed inset-0 z-40 bg-background-overlay flex items-end"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full bg-white rounded-t-3xl px-4 pt-3 pb-7 flex flex-col gap-1"
          >
            <div className="w-10 h-1 rounded bg-slate-200 mx-auto mb-3" />
            {NAV.slice(MOBILE_PRIMARY).map((n) => {
              const Icon = n.icon;
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => go(n.id)}
                  className={cn(
                    'flex items-center gap-3.5 h-[52px] px-3 rounded-xl border-0 text-base font-bold text-left cursor-pointer text-primary',
                    tab === n.id ? 'bg-background-info' : 'bg-transparent'
                  )}
                >
                  <Icon className="w-5 h-5 text-brand" />
                  {n.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

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
    </div>
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

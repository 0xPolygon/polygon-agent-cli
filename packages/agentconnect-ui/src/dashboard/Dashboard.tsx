import type { ElementType } from 'react';

import {
  Activity,
  IdCard,
  LayoutGrid,
  Menu,
  PiggyBank,
  Plus,
  Settings,
  TrendingUp,
  Wallet
} from 'lucide-react';
import { useEffect, useState } from 'react';

import type { ActivityItem, Holding } from '../indexer';
import type { Vault } from './earn.js';
import type { Position } from './markets.js';
import type { Session } from './signin.js';
import type { AgentContext, Loadable } from './tabs.js';

import { LogoBadge } from '../App.js';
import { FundingScreen } from '../components/FundingScreen.js';
import { fetchActivity, fetchHoldings } from '../indexer';
import { SKILL_URL } from './agents.js';
import { ConnectedAgents } from './ConnectedAgents.js';
import { accountEmail, SESSION_AUTH, takeLinkToken } from './credentials-api.js';
import { CredentialsTab } from './Credentials.js';
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
  DETAILS_PROMPTS,
  WALLET_PROMPTS,
  WalletTab
} from './tabs.js';
import { AgentPromptBox, AmountChips, Modal, Toast, useCopy, usd } from './ui.js';

type Tab = 'overview' | 'wallet' | 'markets' | 'earn' | 'credentials' | 'activity' | 'settings';

const NAV: { id: Tab; label: string; icon: ElementType }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutGrid },
  { id: 'wallet', label: 'Wallet', icon: Wallet },
  { id: 'markets', label: 'Markets', icon: TrendingUp },
  { id: 'earn', label: 'Earn', icon: PiggyBank },
  { id: 'credentials', label: 'Credentials', icon: IdCard },
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
  const [toast, setToast] = useState<string | null>(null);
  // The agent's signed token from the link fragment; read once per load.
  const [linkToken] = useState(() => takeLinkToken(walletAddress));
  const owner = session?.wallet === walletAddress.toLowerCase() ? session : null;
  // Saved details: the owner's own sign-in, else the agent's link.
  const auth = owner ? SESSION_AUTH : linkToken;
  const [email] = useState(() => owner?.email ?? accountEmail(walletAddress, linkToken));
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
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (copied) setToast('Copied. Paste it into your agent.');
  }, [copied]);
  const flash = (msg: string) => setToast(msg);

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
    <div className="h-[100dvh] flex bg-[var(--slate-50)] text-[var(--slate-900)] overflow-hidden">
      {/* Sidebar (tablet and up) */}
      <aside className="hidden md:flex w-60 flex-shrink-0 bg-white border-r border-[var(--slate-200)] flex-col px-3 py-5">
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
                className="flex items-center gap-3 h-10 px-3 rounded-[10px] border-0 text-[15px] text-left cursor-pointer transition-colors hover:bg-[var(--slate-50)]"
                style={{
                  background: on ? 'var(--purple-50)' : undefined,
                  color: on ? 'var(--purple-600)' : 'var(--slate-600)',
                  fontWeight: on ? 700 : 500
                }}
              >
                <Icon className="w-[18px] h-[18px]" />
                {n.label}
              </button>
            );
          })}
        </nav>
        <div className="flex-1" />
        <div className="flex items-center gap-2.5 p-3 border-t border-[var(--slate-100)]">
          <span className="w-8 h-8 rounded-full bg-gradient-to-br from-[var(--purple-500)] to-[var(--purple-300)] flex-shrink-0" />
          <span className="flex flex-col gap-0.5 min-w-0">
            <span className="text-sm font-bold truncate max-w-[140px]">
              {email ?? 'Your wallet'}
            </span>
            <span className="text-xs text-[var(--slate-500)]">
              {totalBalance === null ? '…' : usd(totalBalance)}
            </span>
          </span>
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Phone top bar */}
        <div className="md:hidden h-14 flex-shrink-0 flex items-center justify-between px-4 bg-white border-b border-[var(--slate-200)]">
          <div className="flex items-center gap-2">
            <img src="/logo-mark.svg" alt="" className="w-6 h-6" />
            <span className="font-bold text-[17px]">{title}</span>
          </div>
          {email && (
            <span className="text-xs text-[var(--slate-500)] truncate max-w-[50%]">{email}</span>
          )}
        </div>

        <main className="flex-1 overflow-y-auto">
          <div className="max-w-[1000px] mx-auto px-4 pt-5 pb-8 md:px-10 md:pt-9 md:pb-12 flex flex-col gap-8">
            <div className="hidden md:flex justify-between items-center gap-4">
              <h1 className="m-0 text-[28px] font-bold">{title}</h1>
              <button type="button" onClick={openAdd} className="btn btn-primary btn-lg">
                <Plus className="w-4 h-4" />
                Add money
              </button>
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
            {tab === 'credentials' && <CredentialsTab token={auth} onSaved={flash} />}
            {tab === 'credentials' && (
              <AskAgent ctx={ctx} id="c" prompts={DETAILS_PROMPTS} title="Try with your agent" />
            )}
            {tab === 'activity' && <ActivityTab activity={activity} />}
            {tab === 'settings' && owner && <ConnectedAgents />}
            {tab === 'settings' && <SettingsTab address={walletAddress} ctx={ctx} />}
            {tab === 'settings' && owner && (
              <button
                type="button"
                onClick={leave}
                className="btn btn-secondary btn-lg self-start bg-white"
              >
                Sign out
              </button>
            )}

            <div className="text-center text-[13px] text-[var(--slate-400)] pt-2">
              Powered by Polygon
            </div>
          </div>
        </main>

        {/* Phone tab bar */}
        <nav
          className="md:hidden flex-shrink-0 grid grid-cols-5 bg-white border-t border-[var(--slate-200)] px-1 pt-1.5 pb-3.5"
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
                className="flex flex-col items-center justify-center gap-1 h-[52px] border-0 bg-transparent text-[11px] font-bold cursor-pointer"
                style={{ color: on ? 'var(--purple-500)' : 'var(--slate-500)' }}
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
          className="md:hidden fixed inset-0 z-40 bg-[rgba(2,0,5,0.2)] flex items-end"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full bg-white rounded-t-3xl px-4 pt-3 pb-7 flex flex-col gap-1"
          >
            <div className="w-10 h-1 rounded bg-[var(--slate-200)] mx-auto mb-3" />
            {NAV.slice(MOBILE_PRIMARY).map((n) => {
              const Icon = n.icon;
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => go(n.id)}
                  className="flex items-center gap-3.5 h-[52px] px-3 rounded-xl border-0 text-base font-bold text-left cursor-pointer text-[var(--slate-900)]"
                  style={{ background: tab === n.id ? 'var(--purple-50)' : 'transparent' }}
                >
                  <Icon className="w-5 h-5 text-[var(--purple-500)]" />
                  {n.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {modal?.kind === 'add' && (
        <div
          className="fixed inset-0 z-50 flex justify-center overflow-y-auto overflow-x-hidden px-4 py-6 bg-[rgba(2,0,5,0.2)]"
          onClick={() => setModal(null)}
        >
          <div className="w-full max-w-sm my-auto" onClick={(e) => e.stopPropagation()}>
            <FundingScreen
              walletAddress={walletAddress}
              chainId={chainId}
              amount={fundAmount}
              onSkip={() => setModal(null)}
            />
          </div>
        </div>
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

      {toast && <Toast message={toast} raised />}
    </div>
  );
}

// Money only moves through the agent (the wallet's key lives with the CLI), so
// these modals hand the user a ready prompt rather than signing in the browser.

function WithdrawModal({ ctx, onClose }: { ctx: AgentContext; onClose: () => void }) {
  const [amount, setAmount] = useState(50);
  return (
    <Modal
      title="Withdraw"
      sub="Ask your agent to send money back to you. You confirm the request from your email or browser."
      onClose={onClose}
    >
      <AmountChips values={[25, 50, 100, 250]} value={amount} onPick={setAmount} />
      <AgentPromptBox
        {...ctx}
        id="withdraw"
        skill={SKILL_URL}
        text={`withdraw ${amount} USDC from my agent wallet to my own wallet. Ask me which address to send it to.`}
      />
    </Modal>
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
    <Modal
      title={`Deposit into ${vault.tier.name}`}
      sub={
        available === null
          ? `Your agent moves ${vault.symbol} from your balance into the ${vault.tier.name} vault.`
          : `From your available ${vault.symbol} balance of ${usd(available)}.`
      }
      onClose={onClose}
    >
      <AmountChips values={[25, 50, 100, 250]} value={amount} onPick={setAmount} />
      <div className="bg-[var(--slate-50)] rounded-xl px-4 py-3.5 flex flex-col gap-2 text-sm">
        <span className="flex justify-between">
          <span className="text-[var(--slate-600)]">Rate</span>
          <span className="font-bold">{vault.apy.toFixed(2)}% a year</span>
        </span>
        <span className="flex justify-between">
          <span className="text-[var(--slate-600)]">Estimated in 1 year</span>
          <span className="font-bold text-[var(--emerald-700)]">
            +{usd((amount * vault.apy) / 100)}
          </span>
        </span>
        <span className="flex justify-between">
          <span className="text-[var(--slate-600)]">Risk</span>
          <span className="font-bold">{vault.tier.risk}</span>
        </span>
        <span className="flex justify-between">
          <span className="text-[var(--slate-600)]">Withdraw</span>
          <span className="font-bold">Anytime</span>
        </span>
      </div>
      <AgentPromptBox
        {...ctx}
        id="deposit"
        skill={SKILL_URL}
        text={`deposit ${amount} ${vault.symbol} into the ${vault.tier.name} earn vault on Katana (vault ${vault.address}). Bridge the ${vault.symbol} from Polygon to Katana first if needed, then report the rate.`}
      />
    </Modal>
  );
}

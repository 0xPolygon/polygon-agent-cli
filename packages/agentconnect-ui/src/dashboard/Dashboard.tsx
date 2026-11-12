import { useEffect, useState } from 'react';

import {
  SidebarProvider,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast
} from '@polygonlabs/design-system';

import type { ActivityItem, Holding } from '../indexer';
import type { Page } from './AppSidebar.js';
import type { Vault } from './earn.js';
import type { Position } from './markets.js';
import type { PromptGroup } from './PromptsDrawer.js';
import type { Session } from './signin.js';
import type { AgentContext, Loadable } from './types.js';

import { useCopy } from '../hooks/useCopy.js';
import { fetchActivity, fetchHoldings } from '../indexer';
import { usd } from '../utils/format.js';
import { vaultAssets } from '../utils/yieldTotals.js';
import { rememberedEmail } from './account.js';
import { AppSidebar } from './AppSidebar.js';
import { ConnectedAgents } from './ConnectedAgents.js';
import { fetchPolygonRates, fetchVaultBalances, fetchVaults } from './earn.js';
import { fetchPositions, fetchPredictionCash } from './markets.js';
import { AddMoneyModal } from './modals/AddMoneyModal.js';
import { DepositModal } from './modals/DepositModal.js';
import { ReceiveModal } from './modals/ReceiveModal.js';
import { WithdrawModal } from './modals/WithdrawModal.js';
import { ProfileMenu } from './ProfileMenu.js';
import { PromptsDrawer } from './PromptsDrawer.js';
import { signOut } from './signin.js';
import { ActivityTab } from './tabs/ActivityTab.js';
import { MarketsTab } from './tabs/MarketsTab.js';
import { OverviewTab } from './tabs/OverviewTab.js';
import { SettingsTab } from './tabs/SettingsTab.js';
import { WalletTab } from './tabs/WalletTab.js';
import { YieldTab } from './tabs/YieldTab.js';
import { TopBar } from './TopBar.js';

type OverviewSection = 'tokens' | 'history' | 'agents';

function isOverviewSection(v: unknown): v is OverviewSection {
  return v === 'tokens' || v === 'history' || v === 'agents';
}

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

type ModalState =
  | { kind: 'add' }
  | { kind: 'withdraw' }
  | { kind: 'receive' }
  | { kind: 'deposit'; vault: Vault };

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
  const [modal, setModal] = useState<ModalState | null>(initialFundOpen ? { kind: 'add' } : null);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [promptGroup, setPromptGroup] = useState<PromptGroup>('wallet');
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
  const vaultList = vaults.data;
  const vaultBalances = useLoad<Record<string, number>>(
    vaultList ? () => fetchVaultBalances(walletAddress, vaultList) : null,
    [walletAddress, vaults.data]
  );
  const polygonRates = useLoad<Record<string, number>>(fetchPolygonRates, []);
  const vaultsValue = vaultAssets(vaultBalances.data)?.total ?? null;

  useEffect(() => {
    if (copied)
      toast.add({ title: 'Copied. Paste it into your agent.', type: 'success', timeout: 2200 });
  }, [copied]);

  const ctx: AgentContext = { copied, copy };
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
    const rates = polygonRates.data;
    if (!holdings.data || !rates) return null;
    const parts: [number, number | undefined][] = [
      ...holdings.data
        .filter((h) => h.kind === 'earn')
        .map((h): [number, number | undefined] => [h.usd, rates[h.address]]),
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
  const openReceive = () => setModal({ kind: 'receive' });
  const openPrompts = (group: PromptGroup) => {
    setPromptGroup(group);
    setPromptsOpen(true);
  };

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
          <div className="mx-auto flex w-full max-w-[800px] flex-col gap-8 px-4 pb-12 pt-6 md:pt-12 xl:px-0">
            {page === 'overview' && (
              <div className="flex flex-col gap-10">
                <OverviewTab
                  holdings={holdings}
                  positionsValue={positionsValue}
                  vaultsValue={vaultsValue}
                  earningApy={earningApy}
                  go={setPage}
                  onAdd={openAdd}
                  onWithdraw={openWithdraw}
                  onReceive={openReceive}
                  onTryAgent={() => openPrompts('wallet')}
                />
                <div>
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
                      <WalletTab holdings={holdings} />
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
              </div>
            )}
            {page === 'markets' && (
              <MarketsTab
                positions={positions}
                cash={predictionCash}
                hasAccount={!!polymarketAddress}
                onOpenPrompts={() => openPrompts('markets')}
              />
            )}
            {page === 'yield' && (
              <YieldTab
                holdings={holdings}
                vaults={vaults}
                vaultBalances={vaultBalances}
                onDeposit={(vault) => setModal({ kind: 'deposit', vault })}
                onOpenPrompts={() => openPrompts('yield')}
              />
            )}
            {page === 'settings' && <SettingsTab address={walletAddress} ctx={ctx} />}
          </div>
        </main>
      </div>

      {modal?.kind === 'add' && (
        <AddMoneyModal
          walletAddress={walletAddress}
          chainId={chainId}
          amount={fundAmount}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'withdraw' && <WithdrawModal ctx={ctx} onClose={() => setModal(null)} />}
      {modal?.kind === 'receive' && (
        <ReceiveModal address={walletAddress} onClose={() => setModal(null)} />
      )}
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
      <PromptsDrawer
        open={promptsOpen}
        onClose={() => setPromptsOpen(false)}
        initialGroup={promptGroup}
        ctx={ctx}
      />
    </SidebarProvider>
  );
}

import { ArrowDownLeft, ArrowUpRight, Check, Copy, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { ActivityItem, Holding } from '../indexer';
import type { Vault } from './earn.js';
import type { Position } from './markets.js';
import type { TokenLook } from './tokens.js';

import { dailyFlow } from '../indexer';
import { buildPrompt, POLYMARKET_SKILL_URL, SKILL_URL } from './agents.js';
import { cents } from './markets.js';
import { fetchTokenLooks } from './tokens.js';
import {
  AgentPromptBox,
  AmountChips,
  Chip,
  CommandLine,
  CopyButton,
  EmptyState,
  IconTile,
  Panel,
  RowList,
  SectionTitle,
  shortAddr,
  signedUsd,
  usd
} from './ui.js';

export type Loadable<T> = { data: T | null; loading: boolean; error: boolean };

// Shared by every tab: the copy state.
export interface AgentContext {
  copied: string | null;
  copy: (id: string, text: string) => void;
}

const EXPLORER = 'https://polygonscan.com';

function Skeleton({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-block rounded-md bg-[var(--slate-100)] animate-pulse ${className}`} />
  );
}

function sum(holdings: Holding[] | null, kind?: Holding['kind']): number | null {
  if (!holdings) return null;
  return holdings.filter((h) => !kind || h.kind === kind).reduce((s, h) => s + h.usd, 0);
}

// `failed` shows a dash instead of a skeleton that would never resolve.
function Money({
  value,
  failed = false,
  className = ''
}: {
  value: number | null;
  failed?: boolean;
  className?: string;
}) {
  if (value === null && failed) return <span className="text-[var(--slate-400)]">–</span>;
  return value === null ? (
    <Skeleton className="h-[1em] w-32" />
  ) : (
    <span className={className}>{usd(value)}</span>
  );
}

// ── Activity rows ──

function when(ts: string): string {
  const d = new Date(ts);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function qty(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 4 : 2 });
}

export function ActivityRow({ item }: { item: ActivityItem }) {
  const incoming = item.direction === 'in';
  const amount =
    item.usd > 0
      ? signedUsd(incoming ? item.usd : -item.usd)
      : `${incoming ? '+' : '-'}${qty(item.qty)} ${item.symbol}`;
  return (
    <a
      href={`${EXPLORER}/tx/${item.txnHash}`}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 py-3.5 text-[var(--slate-900)] hover:text-[var(--slate-900)] no-underline"
    >
      <IconTile icon={incoming ? ArrowDownLeft : ArrowUpRight} />
      <span className="flex-1 min-w-0 flex flex-col gap-1">
        <span className="text-[15px] font-bold leading-tight">
          {incoming ? 'Received' : 'Sent'} {qty(item.qty)} {item.symbol}
        </span>
        <span className="text-[13px] text-[var(--slate-500)] truncate">
          {incoming ? 'From' : 'To'} {shortAddr(item.counterparty)} · {when(item.timestamp)}
        </span>
      </span>
      <span
        className="text-[15px] font-bold whitespace-nowrap"
        style={{ color: incoming ? 'var(--emerald-700)' : 'var(--slate-900)' }}
      >
        {amount}
      </span>
    </a>
  );
}

function ActivityList({ activity, limit }: { activity: Loadable<ActivityItem[]>; limit?: number }) {
  if (activity.loading) {
    return (
      <RowList>
        {[0, 1, 2].map((i) => (
          <div key={i} className="py-4 flex items-center gap-3">
            <Skeleton className="w-10 h-10" />
            <Skeleton className="h-4 flex-1" />
          </div>
        ))}
      </RowList>
    );
  }
  const rows = (activity.data ?? []).slice(0, limit);
  return (
    <RowList>
      {activity.error ? (
        <EmptyState title="Couldn't load activity">Refresh the page to try again.</EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing yet">
          Money your agents send and receive shows up here.
        </EmptyState>
      ) : (
        rows.map((it, i) => <ActivityRow key={`${it.txnHash}-${i}`} item={it} />)
      )}
    </RowList>
  );
}

// ── Overview ──

function FlowChart({ activity }: { activity: ActivityItem[] }) {
  const days = dailyFlow(activity, 14);
  const max = Math.max(1, ...days.flatMap((d) => [d.in, d.out]));
  const totalIn = days.reduce((s, d) => s + d.in, 0);
  const totalOut = days.reduce((s, d) => s + d.out, 0);
  const label = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const bar = (v: number) => (v ? Math.max(4, (v / max) * 100) : 0) + '%';
  return (
    <Panel className="flex flex-col gap-5">
      <div className="flex justify-between items-start flex-wrap gap-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-lg font-bold">Money in and out</span>
          <span className="text-sm text-[var(--slate-500)]">Last 14 days</span>
        </div>
        <div className="flex gap-5 text-sm">
          {[
            ['In', totalIn, 'var(--purple-500)'],
            ['Out', totalOut, 'var(--slate-300)']
          ].map(([name, v, color]) => (
            <span key={name as string} className="flex flex-col gap-1">
              <span className="flex items-center gap-1.5 text-[var(--slate-500)]">
                <span className="w-2 h-2 rounded-sm" style={{ background: color as string }} />
                {name}
              </span>
              <span className="font-bold text-base">{usd(v as number)}</span>
            </span>
          ))}
        </div>
      </div>
      {totalIn + totalOut === 0 && (
        <span className="text-sm text-[var(--slate-500)] -mb-2">
          No money moved in the last 14 days.
        </span>
      )}
      <div
        className="grid gap-1.5 items-end h-[140px] border-b border-[var(--slate-100)]"
        style={{ gridTemplateColumns: 'repeat(14, minmax(0, 1fr))' }}
        role="img"
        aria-label={`Last 14 days: ${usd(totalIn)} in, ${usd(totalOut)} out`}
      >
        {days.map((d) => (
          <div key={d.date.toISOString()} className="flex gap-0.5 items-end justify-center h-full">
            <div
              className="w-[45%] max-w-3 rounded-t-[3px] bg-[var(--purple-500)]"
              style={{ height: bar(d.in) }}
              title={`${label(d.date)}: ${usd(d.in)} in`}
            />
            <div
              className="w-[45%] max-w-3 rounded-t-[3px] bg-[var(--slate-300)]"
              style={{ height: bar(d.out) }}
              title={`${label(d.date)}: ${usd(d.out)} out`}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-xs text-[var(--slate-400)]">
        <span>{label(days[0].date)}</span>
        <span>{label(days[7].date)}</span>
        <span>Today</span>
      </div>
    </Panel>
  );
}

export function OverviewTab({
  holdings,
  activity,
  positionsValue,
  vaultsValue,
  go,
  onAdd,
  onWithdraw
}: {
  holdings: Loadable<Holding[]>;
  activity: Loadable<ActivityItem[]>;
  positionsValue: number | null;
  // Money in the Katana earn vaults (not in `holdings`, which is Polygon only).
  vaultsValue: number | null;
  go: (tab: string) => void;
  onAdd: () => void;
  onWithdraw: () => void;
}) {
  const total = holdings.error ? 0 : sum(holdings.data);
  const totalWithPositions =
    total === null ? null : total + (positionsValue ?? 0) + (vaultsValue ?? 0);
  const earning = sum(holdings.data, 'earn');
  const buckets = [
    {
      label: 'Available to spend',
      value: sum(holdings.data, 'spend'),
      failed: holdings.error,
      color: 'var(--purple-500)',
      tab: 'wallet'
    },
    {
      label: 'In predictions',
      value: positionsValue,
      failed: false,
      color: 'var(--purple-300)',
      tab: 'markets'
    },
    {
      label: 'Earning',
      value: earning === null ? null : earning + (vaultsValue ?? 0),
      failed: holdings.error,
      color: 'var(--emerald-500)',
      tab: 'earn'
    }
  ];
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <span className="text-[15px] text-[var(--slate-500)]">Total balance</span>
          <span className="text-5xl md:text-[64px] font-bold tracking-[-0.03em] leading-none">
            <Money value={totalWithPositions} />
          </span>
          {holdings.error && (
            <span className="text-[15px] text-[var(--red-700)] font-medium">
              Couldn't load your balance. Refresh to try again.
            </span>
          )}
        </div>
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}
        >
          {buckets.map((b) => (
            <button
              key={b.label}
              type="button"
              onClick={() => go(b.tab)}
              className="flex flex-col gap-2.5 p-4 rounded-2xl border border-[var(--slate-200)] bg-white text-left cursor-pointer hover:border-[var(--slate-400)] transition-colors"
            >
              <span className="flex items-center gap-2 text-sm text-[var(--slate-500)]">
                <span className="w-2 h-2 rounded-full" style={{ background: b.color }} />
                {b.label}
              </span>
              <span className="text-[22px] font-bold">
                {b.value === null && b.tab === 'markets' && !holdings.loading ? (
                  <span className="text-[var(--slate-400)]">See Markets</span>
                ) : (
                  <Money value={b.value} failed={b.failed} />
                )}
              </span>
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2.5 md:hidden">
          <button type="button" onClick={onAdd} className="btn btn-primary btn-lg h-12">
            Add money
          </button>
          <button type="button" onClick={onWithdraw} className="btn btn-secondary btn-lg h-12">
            Withdraw
          </button>
        </div>
      </div>

      {activity.data && <FlowChart activity={activity.data} />}

      <div className="flex flex-col gap-3">
        <div className="flex justify-between items-center">
          <SectionTitle>Recent activity</SectionTitle>
          <button type="button" onClick={() => go('activity')} className="btn btn-ghost btn-md">
            See all
          </button>
        </div>
        <ActivityList activity={activity} limit={4} />
      </div>
    </div>
  );
}

// ── Wallet ──

export function HoldingsList({ holdings }: { holdings: Loadable<Holding[]> }) {
  const rows = holdings.data ?? [];
  const [looks, setLooks] = useState<Record<string, TokenLook>>({});
  useEffect(() => {
    if (!holdings.data?.length) return;
    let live = true;
    void fetchTokenLooks(137, holdings.data).then((l) => live && setLooks(l));
    return () => {
      live = false;
    };
  }, [holdings.data]);
  return (
    <RowList>
      {holdings.loading ? (
        <div className="py-4 flex items-center gap-3">
          <Skeleton className="w-10 h-10" />
          <Skeleton className="h-4 flex-1" />
        </div>
      ) : holdings.error ? (
        <EmptyState title="Couldn't load your balances">Refresh the page to try again.</EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState title="Your wallet is empty">Add money to get your agents started.</EmptyState>
      ) : (
        rows.map((h) => {
          const look = looks[h.address];
          return (
            <div key={h.address + h.symbol} className="flex items-center gap-3.5 py-4">
              {look?.logo ? (
                <img
                  src={look.logo}
                  alt=""
                  className="w-10 h-10 rounded-full flex-shrink-0 bg-[var(--slate-100)] object-cover"
                />
              ) : (
                <span className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-[15px] flex-shrink-0 bg-[var(--slate-100)] text-[var(--slate-700)]">
                  {(look?.name ?? h.name).charAt(0).toUpperCase()}
                </span>
              )}
              <span className="flex-1 min-w-0 text-base font-bold truncate">
                {look?.name ?? h.name}
              </span>
              <span className="text-base font-bold">{usd(h.usd)}</span>
            </div>
          );
        })
      )}
    </RowList>
  );
}

export function ReceivePanel({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="bg-[var(--purple-50)] border border-[var(--purple-200)] rounded-2xl px-5 py-4 flex flex-wrap gap-3 items-center justify-between">
      <span className="flex flex-col gap-1 min-w-0">
        <span className="text-sm font-bold">Receive from another wallet or exchange</span>
        <span className="oms-mono text-[13px] text-[var(--slate-600)] break-all">{address}</span>
        <span className="text-xs text-[var(--slate-500)]">Send only on the Polygon network.</span>
      </span>
      <button
        type="button"
        className="btn btn-secondary btn-md"
        onClick={() => {
          void navigator.clipboard?.writeText(address).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
      >
        {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        {copied ? 'Copied' : 'Copy address'}
      </button>
    </div>
  );
}

export function WalletTab({
  address,
  holdings,
  onAdd,
  onWithdraw
}: {
  address: string;
  holdings: Loadable<Holding[]>;
  onAdd: () => void;
  onWithdraw: () => void;
}) {
  const [showReceive, setShowReceive] = useState(false);
  return (
    <div className="flex flex-col gap-8">
      <div className="flex gap-2 flex-wrap">
        <button type="button" onClick={onAdd} className="btn btn-secondary btn-lg">
          Add money
        </button>
        <button type="button" onClick={onWithdraw} className="btn btn-secondary btn-lg">
          Withdraw
        </button>
        <button
          type="button"
          onClick={() => setShowReceive((v) => !v)}
          className={`btn btn-secondary btn-lg ${showReceive ? 'is-active' : ''}`}
          aria-expanded={showReceive}
        >
          Receive
        </button>
      </div>
      {showReceive && <ReceivePanel address={address} />}
      <div className="flex flex-col gap-3">
        <SectionTitle>What you hold</SectionTitle>
        <HoldingsList holdings={holdings} />
      </div>
    </div>
  );
}

// ── Markets ──

const MARKET_PROMPTS = [
  'show the five most traded Polymarket markets today, with their current odds.',
  'show my open Polymarket positions and how much each has moved.',
  'sell any Polymarket position that has dropped more than 20% since I bought it.',
  'summarize how my predictions did this month.'
];

export function MarketsTab({
  positions,
  cash,
  hasAccount,
  ctx
}: {
  positions: Loadable<Position[]>;
  cash: Loadable<number>;
  hasAccount: boolean;
  ctx: AgentContext;
}) {
  const rows = positions.data ?? [];
  const value = rows.reduce((s, p) => s + p.value, 0);
  const cost = rows.reduce((s, p) => s + p.cost, 0);
  const gain = value - cost;
  return (
    <div className="flex flex-col gap-8">
      {hasAccount && (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}
        >
          {[
            ['Current value', positions.data ? usd(value) : null, undefined],
            ['You put in', positions.data ? usd(cost) : null, undefined],
            [
              'Cash to predict with',
              cash.data !== null ? usd(cash.data) : cash.error ? '–' : null,
              undefined
            ],
            [
              'Gain',
              positions.data ? signedUsd(gain) : null,
              gain >= 0 ? 'var(--emerald-700)' : 'var(--red-700)'
            ]
          ].map(([label, v, color]) => (
            <Panel key={label} pad="p-[18px]" className="flex flex-col gap-2 rounded-[20px]">
              <span className="text-sm text-[var(--slate-500)]">{label}</span>
              <span className="text-[28px] font-bold" style={{ color: color ?? undefined }}>
                {v ?? <Skeleton className="h-7 w-24" />}
              </span>
            </Panel>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3">
        <SectionTitle
          aside={<span className="oms-badge oms-badge--neutral oms-badge--sm">Polymarket</span>}
        >
          Your predictions
        </SectionTitle>
        {!hasAccount ? (
          <RowList>
            <EmptyState title="No predictions on this page yet">
              Ask your agent to make a prediction. Open this page from your agent's latest link to
              see your positions here.
            </EmptyState>
          </RowList>
        ) : positions.error ? (
          <RowList>
            <EmptyState title="Couldn't load your predictions">
              Refresh the page to try again.
            </EmptyState>
          </RowList>
        ) : positions.loading ? (
          <Panel>
            <Skeleton className="h-5 w-2/3" />
          </Panel>
        ) : rows.length === 0 ? (
          <RowList>
            <EmptyState title="No open predictions">
              Ask your agent to find a market for you.
            </EmptyState>
          </RowList>
        ) : (
          <div className="flex flex-col gap-2.5">
            {rows.map((p) => {
              const yes = /^yes$/i.test(p.outcome);
              return (
                <a
                  key={p.title + p.outcome}
                  href={p.slug ? `https://polymarket.com/event/${p.slug}` : undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="bg-white border border-[var(--slate-200)] rounded-[20px] px-5 py-[18px] flex flex-col gap-3.5 text-[var(--slate-900)] hover:text-[var(--slate-900)] hover:border-[var(--slate-400)] transition-colors"
                >
                  <div className="flex justify-between gap-4 items-start">
                    <span className="text-base font-bold leading-snug">{p.title}</span>
                    <span className="flex flex-col gap-1 items-end flex-shrink-0">
                      <span className="text-base font-bold">{usd(p.value)}</span>
                      <span
                        className="text-[13px] font-bold"
                        style={{ color: p.pnl >= 0 ? 'var(--emerald-700)' : 'var(--red-700)' }}
                      >
                        {signedUsd(p.pnl)}
                      </span>
                    </span>
                  </div>
                  <div className="flex items-center gap-3 flex-wrap text-[13px] text-[var(--slate-500)]">
                    <span
                      className={`oms-badge oms-badge--sm ${yes ? 'oms-badge--success' : 'oms-badge--danger'}`}
                    >
                      {p.outcome}
                    </span>
                    <span>
                      Odds {cents(p.avgPrice)} → {cents(p.curPrice)}
                    </span>
                    {p.endDate && (
                      <span>
                        Ends{' '}
                        {new Date(p.endDate).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric'
                        })}
                      </span>
                    )}
                  </div>
                  <div className="h-1.5 rounded-full bg-[var(--slate-100)] overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[var(--purple-500)]"
                      style={{
                        width: `${Math.round(Math.min(1, Math.max(0, p.curPrice)) * 100)}%`
                      }}
                    />
                  </div>
                </a>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <SectionTitle>Ask your agent</SectionTitle>
        <RowList>
          {MARKET_PROMPTS.map((t, i) => (
            <div key={t} className="flex items-center gap-3.5 py-3.5">
              <span className="flex-1 min-w-0">
                <CommandLine text={t} />
              </span>
              <CopyButton
                size="md"
                label="Copy"
                copied={ctx.copied === `m${i}`}
                onClick={() => ctx.copy(`m${i}`, buildPrompt(t, POLYMARKET_SKILL_URL))}
                className="flex-shrink-0"
              />
            </div>
          ))}
        </RowList>
      </div>
    </div>
  );
}

// ── Earn ──

export function EarnTab({
  holdings,
  vaults,
  vaultBalances,
  ctx,
  onDeposit
}: {
  holdings: Loadable<Holding[]>;
  vaults: Loadable<Vault[]>;
  vaultBalances: Loadable<Record<string, number>>;
  ctx: AgentContext;
  onDeposit: (vault: Vault) => void;
}) {
  const inVaults = vaultBalances.data
    ? Object.values(vaultBalances.data).reduce((s, v) => s + v, 0)
    : null;
  // Older Polygon lending positions still count toward what's earning.
  const onPolygon = sum(holdings.data, 'earn');
  const failed = holdings.error || vaultBalances.error || vaults.error;
  const earningTotal =
    onPolygon === null || (inVaults === null && !vaults.error && !vaultBalances.error)
      ? null
      : onPolygon + (inVaults ?? 0);
  const prime = vaults.data?.[0];
  return (
    <div className="flex flex-col gap-8">
      <Panel className="flex flex-wrap gap-6 justify-between items-end">
        <div className="flex flex-col gap-2">
          <span className="text-[15px] text-[var(--slate-500)]">Earning</span>
          <span className="text-[44px] font-bold tracking-[-0.02em] leading-none">
            <Money value={earningTotal} failed={failed} />
          </span>
          {failed && (
            <span className="text-sm text-[var(--red-700)] font-medium">
              Couldn't load your balance. Refresh to try again.
            </span>
          )}
          {earningTotal === 0 && (
            <span className="text-sm text-[var(--slate-500)]">Nothing deposited yet.</span>
          )}
        </div>
        {prime && earningTotal !== null && earningTotal > 0 && (
          <div className="flex flex-col gap-1 items-end">
            <span className="text-sm text-[var(--slate-500)]">At the Prime rate</span>
            <span className="text-lg font-bold">
              ≈ {usd((earningTotal * prime.apy) / 100)} a year
            </span>
          </div>
        )}
      </Panel>

      <div className="flex flex-col gap-3">
        <SectionTitle>Ways to earn</SectionTitle>
        {vaults.error ? (
          <RowList>
            <EmptyState title="Couldn't load rates">Refresh the page to try again.</EmptyState>
          </RowList>
        ) : vaults.data?.length === 0 ? (
          <RowList>
            <EmptyState title="No vaults open right now">Check back soon.</EmptyState>
          </RowList>
        ) : (
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}
          >
            {(vaults.data ?? [null, null, null]).map((v, i) => {
              if (!v) {
                return (
                  <Panel key={i} pad="p-5">
                    <Skeleton className="h-24 w-full" />
                  </Panel>
                );
              }
              const mine = vaultBalances.data?.[v.address] ?? null;
              return (
                <Panel
                  key={v.address}
                  pad="p-5"
                  className={`flex flex-col gap-4 ${i === 0 ? '!border-[var(--purple-200)]' : ''}`}
                >
                  <div className="flex justify-between items-center gap-2">
                    <span className="text-[17px] font-bold">{v.tier.name}</span>
                    <span className={`oms-badge oms-badge--sm ${v.tier.badge}`}>{v.tier.risk}</span>
                  </div>
                  <span className="flex items-baseline gap-1.5">
                    <span className="text-[32px] font-bold text-[var(--purple-500)]">
                      {v.apy.toFixed(2)}%
                    </span>
                    <span className="text-sm text-[var(--slate-500)]">a year</span>
                  </span>
                  <span className="text-sm leading-snug text-[var(--slate-600)]">
                    {v.tier.blurb} Earn on {v.symbol} and withdraw anytime.
                  </span>
                  <div className="flex justify-between text-[13px] text-[var(--slate-500)] pt-3 border-t border-[var(--slate-100)]">
                    <span>{usd(v.tvl)} in the vault</span>
                    <span className="font-bold text-[var(--slate-900)]">
                      {mine === null ? '' : mine > 0 ? `${usd(mine)} deposited` : 'Not deposited'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => onDeposit(v)}
                    className="btn btn-primary btn-lg"
                  >
                    Deposit
                  </button>
                </Panel>
              );
            })}
          </div>
        )}
      </div>

      {!!onPolygon && (
        <div className="flex flex-col gap-3">
          <SectionTitle>Also earning on Polygon</SectionTitle>
          <HoldingsList
            holdings={{ ...holdings, data: holdings.data!.filter((h) => h.kind === 'earn') }}
          />
        </div>
      )}

      <div className="flex flex-col gap-3">
        <SectionTitle>Or let your agent manage it</SectionTitle>
        <Panel pad="p-5">
          <AgentPromptBox
            {...ctx}
            id="earn"
            skill={SKILL_URL}
            text="keep $300 available to spend and move anything above that into the Prime earn vault on Katana. Check every Monday."
          />
        </Panel>
      </div>
    </div>
  );
}

// ── Activity ──

export function ActivityTab({ activity }: { activity: Loadable<ActivityItem[]> }) {
  const [filter, setFilter] = useState<'all' | 'in' | 'out'>('all');
  const data = activity.data?.filter((a) => filter === 'all' || a.direction === filter) ?? null;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex gap-2 flex-wrap">
        {(
          [
            ['all', 'All'],
            ['in', 'Money in'],
            ['out', 'Money out']
          ] as const
        ).map(([id, label]) => (
          <Chip key={id} active={filter === id} onClick={() => setFilter(id)}>
            {label}
          </Chip>
        ))}
      </div>
      <ActivityList activity={{ ...activity, data }} />
    </div>
  );
}

// ── Settings ──

export function SettingsTab({ address, ctx }: { address: string; ctx: AgentContext }) {
  const [limit, setLimit] = useState(200);
  const limitText = `change my agent wallet spending limit to $${limit}.`;
  const links = [
    {
      label: 'View on Polygonscan',
      desc: shortAddr(address),
      href: `${EXPLORER}/address/${address}`
    },
    {
      label: 'Docs',
      desc: 'CLI reference, quickstart, and architecture',
      href: 'https://docs.polygon.technology/payment-services/agentic-payments/polygon-agent-cli'
    },
    {
      label: 'GitHub',
      desc: 'Source code and issues for the Polygon Agent CLI',
      href: 'https://github.com/0xPolygon/polygon-agent-cli'
    },
    {
      label: 'Add your service for agents',
      desc: 'List your API as an x402 service agents can pay for per call',
      href: 'https://agent-discovery.polygon.org/discover'
    }
  ];
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <SectionTitle>Spending limit</SectionTitle>
        <Panel pad="p-5" className="flex flex-col gap-5">
          <span className="text-sm text-[var(--slate-500)] leading-snug">
            Your agents can only spend up to this amount. You approve every change from your email
            or browser.
          </span>
          <AmountChips values={[50, 100, 200, 500]} value={limit} onPick={setLimit} />
          <AgentPromptBox {...ctx} id="limit" skill={SKILL_URL} text={limitText} />
        </Panel>
      </div>

      <div className="flex flex-col gap-3">
        <SectionTitle>Account</SectionTitle>
        <RowList>
          {links.map((l) => (
            <a
              key={l.label}
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full flex items-center gap-4 py-4 text-[var(--slate-900)] hover:text-[var(--slate-900)]"
            >
              <span className="flex-1 flex flex-col gap-1 min-w-0">
                <span className="text-[15px] font-bold">{l.label}</span>
                <span className="text-[13px] text-[var(--slate-500)] truncate">{l.desc}</span>
              </span>
              <ExternalLink className="w-4 h-4 text-[var(--slate-400)] flex-shrink-0" />
            </a>
          ))}
        </RowList>
      </div>
    </div>
  );
}

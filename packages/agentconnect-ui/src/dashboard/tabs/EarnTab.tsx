import { Badge, Button, Card, cn, Skeleton } from '@polygonlabs/design-system';

import type { Holding } from '../../indexer';
import type { Vault } from '../earn.js';
import type { AgentContext, Loadable } from '../types.js';

import { AgentPromptBox } from '../../components/AgentPromptBox.js';
import { EmptyNotice } from '../../components/EmptyNotice.js';
import { Money } from '../../components/Money.js';
import { usd } from '../../utils/format.js';
import { sum } from '../../utils/holdings.js';
import { SKILL_URL } from '../agents.js';
import { HoldingsList } from './HoldingsList.js';
import { ROW_LIST, SECTION_TITLE } from './styles.js';

// earn.ts names a tier's badge by class; Badge takes a variant.
const TIER_BADGE: Record<string, 'success' | 'warning' | 'error'> = {
  'oms-badge--success': 'success',
  'oms-badge--warning': 'warning',
  'oms-badge--danger': 'error'
};

interface EarnTabProps {
  holdings: Loadable<Holding[]>;
  vaults: Loadable<Vault[]>;
  vaultBalances: Loadable<Record<string, number>>;
  ctx: AgentContext;
  onDeposit: (vault: Vault) => void;
}

export function EarnTab({ holdings, vaults, vaultBalances, ctx, onDeposit }: EarnTabProps) {
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
      <Card className="flex flex-wrap gap-6 justify-between items-end">
        <div className="flex flex-col gap-2">
          <span className="text-[15px] text-muted">Earning</span>
          <span className="text-[44px] font-bold tracking-[-0.02em] leading-none">
            <Money value={earningTotal} failed={failed} />
          </span>
          {failed && (
            <span className="text-sm text-destructive font-medium">
              Couldn't load your balance. Refresh to try again.
            </span>
          )}
          {earningTotal === 0 && <span className="text-sm text-muted">Nothing deposited yet.</span>}
        </div>
        {prime && earningTotal !== null && earningTotal > 0 && (
          <div className="flex flex-col gap-1 items-end">
            <span className="text-sm text-muted">At the Prime rate</span>
            <span className="text-lg font-bold">
              ≈ {usd((earningTotal * prime.apy) / 100)} a year
            </span>
          </div>
        )}
      </Card>

      <div className="flex flex-col gap-3">
        <span className={SECTION_TITLE}>Ways to earn</span>
        {vaults.error ? (
          <Card className={ROW_LIST}>
            <EmptyNotice title="Couldn't load rates">Refresh the page to try again.</EmptyNotice>
          </Card>
        ) : vaults.data?.length === 0 ? (
          <Card className={ROW_LIST}>
            <EmptyNotice title="No vaults open right now">Check back soon.</EmptyNotice>
          </Card>
        ) : (
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}
          >
            {(vaults.data ?? [null, null, null]).map((v, i) => {
              if (!v) {
                return (
                  <Card key={i} className="p-5">
                    <Skeleton className="h-24 w-full" />
                  </Card>
                );
              }
              const mine = vaultBalances.data?.[v.address] ?? null;
              return (
                <Card
                  key={v.address}
                  className={cn('p-5 flex flex-col gap-4', i === 0 && 'border-purple-200')}
                >
                  <div className="flex justify-between items-center gap-2">
                    <span className="text-[17px] font-bold">{v.tier.name}</span>
                    <Badge variant={TIER_BADGE[v.tier.badge] ?? 'neutral'} size="sm">
                      {v.tier.risk}
                    </Badge>
                  </div>
                  <span className="flex items-baseline gap-1.5">
                    <span className="text-[32px] font-bold text-brand">{v.apy.toFixed(2)}%</span>
                    <span className="text-sm text-muted">a year</span>
                  </span>
                  <span className="text-sm leading-snug text-slate-600">
                    {v.tier.blurb} Earn on {v.symbol} and withdraw anytime.
                  </span>
                  <div className="flex justify-between text-[13px] text-muted pt-3 border-t border-slate-100">
                    <span>{usd(v.tvl)} in the vault</span>
                    <span className="font-bold text-primary">
                      {mine === null ? '' : mine > 0 ? `${usd(mine)} deposited` : 'Not deposited'}
                    </span>
                  </div>
                  <Button
                    type="button"
                    size="lg"
                    onClick={() => onDeposit(v)}
                    className="justify-center"
                  >
                    Deposit
                  </Button>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {!!onPolygon && (
        <div className="flex flex-col gap-3">
          <span className={SECTION_TITLE}>Also earning on Polygon</span>
          <HoldingsList
            holdings={{ ...holdings, data: holdings.data!.filter((h) => h.kind === 'earn') }}
          />
        </div>
      )}

      <div className="flex flex-col gap-3">
        <span className={SECTION_TITLE}>Or let your agent manage it</span>
        <Card className="p-5">
          <AgentPromptBox
            {...ctx}
            id="earn"
            skill={SKILL_URL}
            text="keep $300 available to spend and move anything above that into the Prime earn vault on Katana. Check every Monday."
          />
        </Card>
      </div>
    </div>
  );
}

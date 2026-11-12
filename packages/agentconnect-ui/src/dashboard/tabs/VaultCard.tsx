import { Bot, ExternalLink, Plus } from 'lucide-react';

import { Badge, Button, Card, cn, focusRingVariants } from '@polygonlabs/design-system';

import type { Vault } from '../earn.js';

import { Money } from '../../components/Money.js';
import { usd } from '../../utils/format.js';
import { vaultUrl } from '../../utils/vaultUrl.js';

// earn.ts names a tier's badge by class; Badge takes a variant.
const TIER_BADGE: Record<string, 'success' | 'warning' | 'error'> = {
  'oms-badge--success': 'success',
  'oms-badge--warning': 'warning',
  'oms-badge--danger': 'error'
};

interface VaultCardProps {
  vault: Vault;
  assets: number | null;
  failed: boolean;
  onDeposit: (vault: Vault) => void;
  onTryAgent: () => void;
}

export function VaultCard({ vault: v, assets, failed, onDeposit, onTryAgent }: VaultCardProps) {
  const deposited = assets !== null && assets > 0;
  return (
    <Card variant="outline" className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-start justify-between gap-3">
            <a
              href={vaultUrl(v.address)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${v.tier.name} vault on the Katana explorer`}
              className={cn(
                'inline-flex items-center gap-2 rounded-sm text-lg font-bold text-primary hover:text-link sm:text-xl',
                focusRingVariants()
              )}
            >
              {v.tier.name}
              <ExternalLink className="size-4 stroke-2" />
            </a>
            <Badge
              variant={TIER_BADGE[v.tier.badge] ?? 'neutral'}
              size="sm"
              className="shrink-0 px-2"
            >
              {v.tier.risk}
            </Badge>
          </div>
          <span className="text-xs font-medium text-muted sm:text-sm">
            {usd(v.tvl)} in the vault
          </span>
        </div>
        <p className="m-0 text-sm text-muted">
          {v.tier.blurb} Earn on {v.symbol} and withdraw anytime.
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted">Your assets in vault</span>
        <span className="text-3xl leading-tight font-bold">
          <Money value={assets} failed={failed} />
        </span>
        <span className={cn('text-sm font-medium', deposited ? 'text-success' : 'text-muted')}>
          {deposited ? 'Earning' : 'Pays'} {v.apy.toFixed(2)}% a year
        </span>
      </div>
      {/* The card's own width decides side by side vs stacked; the viewport can't (the grid is 1 or 2 columns). */}
      <div className="@container">
        <div className="flex flex-col gap-2 md:@xs:flex-row">
          <Button
            type="button"
            size="lg"
            onClick={() => onDeposit(v)}
            className="justify-center px-3 [&_svg]:shrink-0"
          >
            <Plus />
            Deposit
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            onClick={onTryAgent}
            className="justify-center md:@xs:flex-1 [&_svg]:shrink-0"
          >
            <Bot />
            Try with your agent
          </Button>
        </div>
      </div>
    </Card>
  );
}

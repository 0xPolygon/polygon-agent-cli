import { Badge, Card, cn, Progress, Skeleton } from '@polygonlabs/design-system';

import type { Position } from '../markets.js';
import type { Loadable } from '../types.js';

import { EmptyNotice } from '../../components/EmptyNotice.js';
import { PromptsButton } from '../../components/PromptsButton.js';
import { signedUsd, usd } from '../../utils/format.js';
import { cents } from '../markets.js';
import { ROW_LIST, SECTION_TITLE } from './styles.js';

interface MarketsTabProps {
  positions: Loadable<Position[]>;
  cash: Loadable<number>;
  hasAccount: boolean;
  onOpenPrompts: () => void;
}

export function MarketsTab({ positions, cash, hasAccount, onOpenPrompts }: MarketsTabProps) {
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
              gain >= 0 ? 'text-success' : 'text-destructive'
            ]
          ].map(([label, v, color]) => (
            <Card key={label} className="p-[18px] flex flex-col gap-2 rounded-[20px]">
              <span className="text-sm text-muted">{label}</span>
              <span className={cn('text-[28px] font-bold', color)}>
                {v ?? <Skeleton className="h-7 w-24" />}
              </span>
            </Card>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className={SECTION_TITLE}>Your predictions</span>
          <Badge variant="neutral" size="sm">
            Polymarket
          </Badge>
          <span className="ml-auto">
            <PromptsButton onClick={onOpenPrompts} />
          </span>
        </div>
        {!hasAccount ? (
          <Card className={ROW_LIST}>
            <EmptyNotice title="No predictions on this page yet">
              Ask your agent to make a prediction. Open this page from your agent's latest link to
              see your positions here.
            </EmptyNotice>
          </Card>
        ) : positions.error ? (
          <Card className={ROW_LIST}>
            <EmptyNotice title="Couldn't load your predictions">
              Refresh the page to try again.
            </EmptyNotice>
          </Card>
        ) : positions.loading ? (
          <Card>
            <Skeleton className="h-5 w-2/3" />
          </Card>
        ) : rows.length === 0 ? (
          <Card className={ROW_LIST}>
            <EmptyNotice title="No open predictions">
              Ask your agent to find a market for you.
            </EmptyNotice>
          </Card>
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
                  className="bg-white border border-slate-200 rounded-[20px] px-5 py-[18px] flex flex-col gap-3.5 text-primary hover:text-primary hover:border-border-hover transition-colors"
                >
                  <div className="flex justify-between gap-4 items-start">
                    <span className="text-base font-bold leading-snug">{p.title}</span>
                    <span className="flex flex-col gap-1 items-end flex-shrink-0">
                      <span className="text-base font-bold">{usd(p.value)}</span>
                      <span
                        className={cn(
                          'text-[13px] font-bold',
                          p.pnl >= 0 ? 'text-success' : 'text-destructive'
                        )}
                      >
                        {signedUsd(p.pnl)}
                      </span>
                    </span>
                  </div>
                  <div className="flex items-center gap-3 flex-wrap text-[13px] text-muted">
                    <Badge variant={yes ? 'success' : 'error'} size="sm">
                      {p.outcome}
                    </Badge>
                    <span>
                      Bought at {cents(p.avgPrice)} · Now {cents(p.curPrice)}
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
                  <Progress
                    value={Math.round(Math.min(1, Math.max(0, p.curPrice)) * 100)}
                    size="sm"
                    trackClassName="h-1.5 bg-slate-100"
                    aria-label={`${p.outcome} price`}
                  />
                </a>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

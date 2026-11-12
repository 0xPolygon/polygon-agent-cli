import { useEffect, useState } from 'react';

import { Card, Skeleton } from '@polygonlabs/design-system';

import type { Holding } from '../../indexer';
import type { TokenLook } from '../tokens.js';
import type { Loadable } from '../types.js';

import { EmptyNotice } from '../../components/EmptyNotice.js';
import { usd } from '../../utils/format.js';
import { fetchTokenLooks } from '../tokens.js';
import { ROW_LIST } from './styles.js';

interface HoldingsListProps {
  holdings: Loadable<Holding[]>;
}

export function HoldingsList({ holdings }: HoldingsListProps) {
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
    <Card className={ROW_LIST}>
      {holdings.loading ? (
        <div className="py-4 flex items-center gap-3">
          <Skeleton className="w-10 h-10" />
          <Skeleton className="h-4 flex-1" />
        </div>
      ) : holdings.error ? (
        <EmptyNotice title="Couldn't load your balances">
          Refresh the page to try again.
        </EmptyNotice>
      ) : rows.length === 0 ? (
        <EmptyNotice title="Your wallet is empty">
          Add money to get your agents started.
        </EmptyNotice>
      ) : (
        rows.map((h) => {
          const look = looks[h.address];
          return (
            <div key={h.address + h.symbol} className="flex items-center gap-3.5 py-4">
              {look?.logo ? (
                <img
                  src={look.logo}
                  alt=""
                  className="w-10 h-10 rounded-full flex-shrink-0 bg-slate-100 object-cover"
                />
              ) : (
                <span className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-[15px] flex-shrink-0 bg-slate-100 text-slate-700">
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
    </Card>
  );
}

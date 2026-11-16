import { Card } from '@polygonlabs/design-system';

import type { Holding } from '../../indexer';
import type { TokenLook } from '../tokens.js';

import { TokenIcon } from '../../components/TokenIcon.js';
import { qty, usd } from '../../utils/format.js';

interface HoldingRowProps {
  holding: Holding;
  look?: TokenLook;
}

export function HoldingRow({ holding, look }: HoldingRowProps) {
  return (
    <Card
      variant="outline"
      className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5"
    >
      <span className="flex min-w-0 items-center gap-2">
        <TokenIcon
          symbol={holding.symbol}
          logo={look?.logo}
          chainId={holding.chainId}
          className="shrink-0"
        />
        <span className="truncate text-sm font-bold">{look?.name ?? holding.name}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="text-base font-bold leading-none">{usd(holding.usd)}</span>
        <span className="text-xs font-bold leading-none text-muted">
          {qty(holding.qty)} {holding.symbol}
        </span>
      </span>
    </Card>
  );
}

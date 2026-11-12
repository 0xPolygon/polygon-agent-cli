import { cn, TableCell, TableRow } from '@polygonlabs/design-system';

import type { ActivityItem } from '../../indexer';
import type { ActivityKind } from '../derive.js';

import { DirectionBadge } from '../../components/DirectionBadge.js';
import { TokenIcon } from '../../components/TokenIcon.js';
import { qty, shortAddr, usd } from '../../utils/format.js';
import { EXPLORER } from '../explorer.js';

interface ActivityTableRowProps {
  item: ActivityItem;
  kind: ActivityKind;
  logo?: string;
}

const KIND_LABEL: Record<ActivityKind, string> = {
  send: 'Send',
  receive: 'Receive',
  swap: 'Swap'
};

const day = (ts: string) =>
  new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function ActivityTableRow({ item, kind, logo }: ActivityTableRowProps) {
  const incoming = item.direction === 'in';
  return (
    <TableRow>
      <TableCell>
        <a
          href={`${EXPLORER}/tx/${item.txnHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary no-underline hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {day(item.timestamp)}
        </a>
      </TableCell>
      <TableCell>{KIND_LABEL[kind]}</TableCell>
      <TableCell>
        <span className="flex items-center gap-1.5">
          <span className={cn(incoming ? 'text-success' : 'text-info')}>
            {incoming ? '+' : '-'}
            {qty(item.qty)}
          </span>
          <TokenIcon symbol={item.symbol} logo={logo} plainFallback className="size-4 shrink-0" />
          <span className="max-w-20 truncate" title={item.symbol}>
            {item.symbol}
          </span>
        </span>
      </TableCell>
      <TableCell>{item.usd > 0 ? usd(item.usd) : '—'}</TableCell>
      <TableCell>
        {item.counterparty ? `${incoming ? 'From' : 'To'}: ${shortAddr(item.counterparty)}` : '—'}
      </TableCell>
      <TableCell>
        <DirectionBadge direction={item.direction} />
      </TableCell>
    </TableRow>
  );
}

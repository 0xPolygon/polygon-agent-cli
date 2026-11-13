import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';

import { Badge } from '@polygonlabs/design-system';

interface DirectionBadgeProps {
  direction: 'in' | 'out';
}

export function DirectionBadge({ direction }: DirectionBadgeProps) {
  const incoming = direction === 'in';
  const Icon = incoming ? ArrowDownLeft : ArrowUpRight;
  return (
    <Badge variant={incoming ? 'success' : 'info'}>
      <Icon aria-hidden />
      {incoming ? 'Inbound' : 'Outbound'}
    </Badge>
  );
}

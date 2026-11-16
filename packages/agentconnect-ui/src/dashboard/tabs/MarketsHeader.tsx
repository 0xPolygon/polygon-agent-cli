import { Money } from '../../components/Money.js';
import { StatLine } from '../../components/StatLine.js';
import { TotalAssetsHeader } from '../../components/TotalAssetsHeader.js';
import { signedUsd } from '../../utils/format.js';

interface MarketsHeaderProps {
  total: number | null;
  deposited: number | null;
  earned: number | null;
  cash: number | null;
  failed: boolean;
  cashFailed: boolean;
}

export function MarketsHeader({
  total,
  deposited,
  earned,
  cash,
  failed,
  cashFailed
}: MarketsHeaderProps) {
  return (
    <TotalAssetsHeader label="Total assets in prediction markets" total={total} failed={failed}>
      <StatLine label="Deposited">
        <Money value={deposited} failed={failed} />
      </StatLine>
      <StatLine label="Earned">
        {earned === null ? (
          <Money value={null} failed={failed} />
        ) : (
          <span className={earned >= 0 ? 'text-success' : 'text-destructive'}>
            {signedUsd(earned)}
          </span>
        )}
      </StatLine>
      <StatLine label="Cash to predict with">
        <Money value={cash} failed={cashFailed} />
      </StatLine>
    </TotalAssetsHeader>
  );
}

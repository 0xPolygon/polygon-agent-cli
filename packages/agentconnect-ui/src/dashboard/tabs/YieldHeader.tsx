import { Money } from '../../components/Money.js';
import { StatLine } from '../../components/StatLine.js';
import { TotalAssetsHeader } from '../../components/TotalAssetsHeader.js';

interface YieldHeaderProps {
  total: number | null;
  failed: boolean;
}

export function YieldHeader({ total, failed }: YieldHeaderProps) {
  return (
    <TotalAssetsHeader label="Total assets in vaults" total={total} failed={failed}>
      <StatLine label="Deposited">
        <Money value={total} failed={failed} />
      </StatLine>
    </TotalAssetsHeader>
  );
}

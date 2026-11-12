import { useState } from 'react';

import { Button } from '@polygonlabs/design-system';

import type { Holding } from '../../indexer';
import type { Loadable } from '../types.js';

import { HoldingsList } from './HoldingsList.js';
import { ReceivePanel } from './ReceivePanel.js';
import { SECTION_TITLE } from './styles.js';

interface WalletTabProps {
  address: string;
  holdings: Loadable<Holding[]>;
  onAdd: () => void;
  onWithdraw: () => void;
}

export function WalletTab({ address, holdings, onAdd, onWithdraw }: WalletTabProps) {
  const [showReceive, setShowReceive] = useState(false);
  return (
    <div className="flex flex-col gap-8">
      <div className="flex gap-2 flex-wrap">
        <Button type="button" variant="secondary" size="lg" onClick={onAdd}>
          Add money
        </Button>
        <Button type="button" variant="secondary" size="lg" onClick={onWithdraw}>
          Withdraw
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="lg"
          onClick={() => setShowReceive((v) => !v)}
          aria-expanded={showReceive}
        >
          Receive
        </Button>
      </div>
      {showReceive && <ReceivePanel address={address} />}
      <div className="flex flex-col gap-3">
        <span className={SECTION_TITLE}>What you hold</span>
        <HoldingsList holdings={holdings} />
      </div>
    </div>
  );
}

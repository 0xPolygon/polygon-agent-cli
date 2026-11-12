import type { Holding } from '../../indexer';
import type { Loadable } from '../types.js';

import { PromptsButton } from '../../components/PromptsButton.js';
import { HoldingsList } from './HoldingsList.js';
import { SECTION_TITLE } from './styles.js';

interface WalletTabProps {
  holdings: Loadable<Holding[]>;
  onOpenPrompts: () => void;
}

export function WalletTab({ holdings, onOpenPrompts }: WalletTabProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className={SECTION_TITLE}>What you hold</span>
        <PromptsButton onClick={onOpenPrompts} />
      </div>
      <HoldingsList holdings={holdings} />
    </div>
  );
}

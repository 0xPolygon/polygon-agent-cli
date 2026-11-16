import { PiggyBank } from 'lucide-react';
import { useState } from 'react';

import type { Vault } from '../earn.js';
import type { AgentContext } from '../types.js';

import { AgentPromptBox } from '../../components/AgentPromptBox.js';
import { AmountChips } from '../../components/AmountChips.js';
import { ModalShell } from '../../components/ModalShell.js';
import { usd } from '../../utils/format.js';
import { SKILL_URL } from '../agents.js';

interface DepositModalProps {
  vault: Vault;
  available: number | null;
  ctx: AgentContext;
  onClose: () => void;
}

export function DepositModal({ vault, available, ctx, onClose }: DepositModalProps) {
  const [amount, setAmount] = useState(100);
  return (
    <ModalShell
      icon={PiggyBank}
      title={`Deposit into ${vault.tier.name}`}
      description={
        available === null
          ? `Your agent moves ${vault.symbol} from your balance into the ${vault.tier.name} vault.`
          : `From your available ${vault.symbol} balance of ${usd(available)}.`
      }
      onClose={onClose}
      action={
        <AgentPromptBox
          {...ctx}
          variant="default"
          id="deposit"
          skill={SKILL_URL}
          text={`deposit ${amount} ${vault.symbol} into the ${vault.tier.name} earn vault on Katana (vault ${vault.address}). Bridge the ${vault.symbol} from Polygon to Katana first if needed, then report the rate.`}
        />
      }
    >
      <AmountChips values={[25, 50, 100, 250]} value={amount} onPick={setAmount} />
      <div className="bg-background-muted rounded-xl px-4 py-3.5 flex flex-col gap-2 text-sm">
        <span className="flex justify-between">
          <span className="text-slate-600">Rate</span>
          <span className="font-bold">{vault.apy.toFixed(2)}% a year</span>
        </span>
        <span className="flex justify-between">
          <span className="text-slate-600">Estimated in 1 year</span>
          <span className="font-bold text-success">+{usd((amount * vault.apy) / 100)}</span>
        </span>
        <span className="flex justify-between">
          <span className="text-slate-600">Risk</span>
          <span className="font-bold">{vault.tier.risk}</span>
        </span>
        <span className="flex justify-between">
          <span className="text-slate-600">Withdraw</span>
          <span className="font-bold">Anytime</span>
        </span>
      </div>
    </ModalShell>
  );
}

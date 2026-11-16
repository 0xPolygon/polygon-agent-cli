import { ArrowUpRight } from 'lucide-react';
import { useState } from 'react';

import type { AgentContext } from '../types.js';

import { AgentPromptBox } from '../../components/AgentPromptBox.js';
import { AmountChips } from '../../components/AmountChips.js';
import { ModalShell } from '../../components/ModalShell.js';
import { SKILL_URL } from '../agents.js';

interface WithdrawModalProps {
  ctx: AgentContext;
  onClose: () => void;
}

// Money only moves through the agent (the key lives with the CLI), so the modal hands over a prompt.
export function WithdrawModal({ ctx, onClose }: WithdrawModalProps) {
  const [amount, setAmount] = useState(50);
  return (
    <ModalShell
      icon={ArrowUpRight}
      title="Withdraw"
      description="Ask your agent to send money back to you. You confirm the request from your email or browser."
      onClose={onClose}
      action={
        <AgentPromptBox
          {...ctx}
          variant="default"
          id="withdraw"
          skill={SKILL_URL}
          text={`withdraw ${amount} USDC from my agent wallet to my own wallet. Ask me which address to send it to.`}
        />
      }
    >
      <AmountChips values={[25, 50, 100, 250]} value={amount} onPick={setAmount} />
    </ModalShell>
  );
}

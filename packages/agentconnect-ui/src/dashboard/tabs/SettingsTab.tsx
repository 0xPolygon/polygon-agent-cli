import { ExternalLink } from 'lucide-react';
import { useState } from 'react';

import { Card } from '@polygonlabs/design-system';

import type { AgentContext } from '../types.js';

import { AgentPromptBox } from '../../components/AgentPromptBox.js';
import { AmountChips } from '../../components/AmountChips.js';
import { shortAddr } from '../../utils/format.js';
import { SKILL_URL } from '../agents.js';
import { EXPLORER } from '../explorer.js';
import { ROW_LIST, SECTION_TITLE } from './styles.js';

interface SettingsTabProps {
  address: string;
  ctx: AgentContext;
}

export function SettingsTab({ address, ctx }: SettingsTabProps) {
  const [limit, setLimit] = useState(200);
  const limitText = `change my agent wallet spending limit to $${limit}.`;
  const links = [
    {
      label: 'View on Polygonscan',
      desc: shortAddr(address),
      href: `${EXPLORER}/address/${address}`
    },
    {
      label: 'Docs',
      desc: 'CLI reference, quickstart, and architecture',
      href: 'https://docs.polygon.technology/payment-services/agentic-payments/polygon-agent-cli'
    },
    {
      label: 'GitHub',
      desc: 'Source code and issues for the Polygon Agent CLI',
      href: 'https://github.com/0xPolygon/polygon-agent-cli'
    },
    {
      label: 'Add your service for agents',
      desc: 'List your API as an x402 service agents can pay for per call',
      href: 'https://agent-discovery.polygon.org/discover'
    }
  ];
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <span className={SECTION_TITLE}>Spending limit</span>
        <Card className="p-5 flex flex-col gap-5">
          <span className="text-sm text-muted leading-snug">
            Your agents can only spend up to this amount. You approve every change from your email
            or browser.
          </span>
          <AmountChips values={[50, 100, 200, 500]} value={limit} onPick={setLimit} />
          <AgentPromptBox {...ctx} id="limit" skill={SKILL_URL} text={limitText} />
        </Card>
      </div>

      <div className="flex flex-col gap-3">
        <span className={SECTION_TITLE}>Account</span>
        <Card className={ROW_LIST}>
          {links.map((l) => (
            <a
              key={l.label}
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full flex items-center gap-4 py-4 text-primary hover:text-primary"
            >
              <span className="flex-1 flex flex-col gap-1 min-w-0">
                <span className="text-[15px] font-bold">{l.label}</span>
                <span className="text-[13px] text-muted truncate">{l.desc}</span>
              </span>
              <ExternalLink className="w-4 h-4 text-slate-400 flex-shrink-0" />
            </a>
          ))}
        </Card>
      </div>
    </div>
  );
}

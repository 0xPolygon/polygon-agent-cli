import { ArrowDownLeft, Target, Zap } from 'lucide-react';
import { useState } from 'react';

import { LogoBadge } from '../App.js';
import { agentById, SKILL_URL } from './agents.js';
import { AgentChips, AmountChips, CommandLine, CopyButton, IconTile, useCopy } from './ui.js';

const INSTALL = 'npx skills add https://github.com/0xPolygon/polygon-agent-cli';

// An illustration of the dashboard, not the visitor's data.
const EXAMPLE_ROWS = [
  {
    icon: Target,
    title: 'Predicted Yes on "Fed cuts rates in December?"',
    agent: 'Codex',
    color: '#059669',
    amount: '-$5.00'
  },
  {
    icon: Zap,
    title: 'Paid for 14 web searches',
    agent: 'Hermes',
    color: '#DB2777',
    amount: '-$0.28'
  },
  {
    icon: ArrowDownLeft,
    title: 'Received 50 USDC',
    agent: 'You',
    color: '#48526F',
    amount: '+$50.00'
  }
];

/** Shown when the page is opened without a wallet: connect an agent first. */
export function Onboarding() {
  const [agentId, setAgentId] = useState('claude');
  const [limit, setLimit] = useState(200);
  const [copied, copy] = useCopy();
  const agent = agentById(agentId);
  const text = `connect my Polygon agent wallet with a $${limit} spending limit.`;

  return (
    <div className="min-h-[100dvh] flex flex-col bg-[var(--slate-50)] text-[var(--slate-900)]">
      <div className="h-16 flex items-center px-6 bg-white border-b border-[var(--slate-200)]">
        <LogoBadge />
      </div>
      <div className="flex-1 grid md:grid-cols-2 gap-12 max-w-[1120px] w-full mx-auto px-5 pt-7 pb-10 md:px-10 md:py-12 items-center">
        <div className="flex flex-col gap-6 max-w-[460px] w-full">
          <div className="flex flex-col gap-3">
            <h1 className="m-0 text-[34px] md:text-[44px] leading-[1.1] font-bold tracking-[-0.02em]">
              A wallet your agent can spend from
            </h1>
            <p className="m-0 text-lg leading-snug text-[var(--slate-600)]">
              Let Claude, Codex, or any agent you use trade, predict, earn, and pay for services,
              within a limit you set.
            </p>
          </div>

          <div className="flex flex-col gap-2.5">
            <span className="text-sm font-medium text-[var(--slate-600)]">Agent</span>
            <AgentChips agent={agent} onPick={setAgentId} size="md" label={null} />
          </div>

          <div className="flex flex-col gap-2.5">
            <span className="text-sm font-medium text-[var(--slate-600)]">Spending limit</span>
            <AmountChips values={[50, 100, 200, 500]} value={limit} onPick={setLimit} />
            <span className="text-[13px] text-[var(--slate-500)]">
              You sign in once with Google or email to approve it. Change it anytime.
            </span>
          </div>

          <div className="border border-[var(--slate-200)] rounded-2xl bg-white p-4 flex flex-col gap-3">
            <CommandLine agent={agent} text={text} />
            <CopyButton
              copied={copied === 'setup'}
              onClick={() => copy('setup', agent.build(text, SKILL_URL))}
              className="w-full h-11"
            />
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[13px] text-[var(--slate-500)]">
              Using a skills-compatible agent? Install the skill instead, then ask it to set up a
              Polygon agent wallet.
            </span>
            <button
              type="button"
              onClick={() => copy('install', INSTALL)}
              className="flex items-center gap-2 bg-white border border-[var(--slate-200)] hover:border-[var(--slate-400)] rounded-xl px-3 py-2.5 cursor-pointer text-left"
            >
              <code className="oms-mono flex-1 min-w-0 text-[13px] break-all">{INSTALL}</code>
              <span className="text-[13px] font-bold text-[var(--slate-500)] flex-shrink-0">
                {copied === 'install' ? 'Copied' : 'Copy'}
              </span>
            </button>
          </div>
        </div>

        <div className="hidden md:flex bg-white border border-[var(--slate-200)] rounded-3xl p-7 flex-col gap-5">
          <div className="flex justify-between items-start">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm text-[var(--slate-500)]">Balance</span>
              <span className="text-[40px] font-bold tracking-[-0.02em]">$245.72</span>
            </div>
            <span className="oms-badge oms-badge--neutral oms-badge--sm">Example</span>
          </div>
          <div className="h-px bg-[var(--slate-100)]" />
          <span className="text-sm font-bold text-[var(--slate-600)]">
            What your agents did today
          </span>
          <div className="flex flex-col gap-1">
            {EXAMPLE_ROWS.map((r) => (
              <div key={r.title} className="flex items-center gap-3 py-2.5">
                <IconTile icon={r.icon} size={36} />
                <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <span className="text-[15px] font-bold">{r.title}</span>
                  <span className="text-[13px] font-bold" style={{ color: r.color }}>
                    {r.agent}
                  </span>
                </span>
                <span
                  className="text-[15px] font-bold"
                  style={{ color: r.amount.startsWith('+') ? 'var(--emerald-700)' : undefined }}
                >
                  {r.amount}
                </span>
              </div>
            ))}
          </div>
          <div className="bg-[var(--slate-50)] rounded-xl px-4 py-3.5 flex justify-between text-sm">
            <span className="text-[var(--slate-600)]">Spending limit</span>
            <span className="font-bold">$5.28 of ${limit} used</span>
          </div>
        </div>
      </div>
    </div>
  );
}

import type { ElementType } from 'react';

import {
  ArrowDownToLine,
  ArrowLeftRight,
  Calculator,
  Inbox,
  LineChart,
  PiggyBank,
  Search,
  Send,
  Target,
  TrendingUp,
  Zap
} from 'lucide-react';

export const SKILL_URL = 'https://agentconnect.polygon.technology/polygon-agent-cli/SKILL.md';
export const POLYMARKET_SKILL_URL =
  'https://agentconnect.polygon.technology/polygon-polymarket/SKILL.md';
// x402 services catalog skill: pay-per-use prompts point the agent here so it
// knows which service routes to call (not the agentconnect/CLI skill).
export const AGENTIC_SERVICES_SKILL_URL = 'https://agent-discovery.polygon.org/SKILL.md';

export interface Agent {
  id: string;
  name: string;
  color: string;
  tint: string;
  // What the terminal line starts with, shown in color before the prompt.
  prefix: string;
  build: (text: string, skillUrl: string) => string;
}

export const AGENTS: Agent[] = [
  {
    id: 'claude',
    name: 'Claude',
    color: '#EA580C',
    tint: '#FFF7ED',
    prefix: 'claude',
    build: (text, skill) => `claude "Read ${skill} and ${text}"`
  },
  {
    id: 'codex',
    name: 'Codex',
    color: '#059669',
    tint: '#ECFDF5',
    prefix: 'codex',
    build: (text, skill) => `codex "Read ${skill} and ${text}"`
  },
  {
    id: 'openclaw',
    name: 'Openclaw',
    color: '#670DE5',
    tint: '#F6F3FB',
    prefix: 'clawhub',
    build: (text, skill) => `npx clawhub@latest run "Read ${skill} and ${text}"`
  },
  {
    id: 'hermes',
    name: 'Hermes',
    color: '#DB2777',
    tint: '#FDF2F8',
    prefix: 'hermes',
    build: (text, skill) => `hermes "Read ${skill} and ${text}"`
  }
];

export function agentById(id: string): Agent {
  return AGENTS.find((a) => a.id === id) ?? AGENTS[0];
}

export interface Prompt {
  icon: ElementType;
  label: string;
  text: string;
  skill: string;
}

export const PROMPT_CATEGORIES: { id: string; label: string; prompts: Prompt[] }[] = [
  {
    id: 'predict',
    label: 'Predictions',
    prompts: [
      {
        icon: Target,
        label: 'Make a prediction',
        text: 'find the most traded Polymarket market about the Fed and put $5 on the side with better odds, with a price limit.',
        skill: POLYMARKET_SKILL_URL
      },
      {
        icon: LineChart,
        label: 'Check my positions',
        text: 'show my open Polymarket positions and how much each has moved.',
        skill: POLYMARKET_SKILL_URL
      }
    ]
  },
  {
    id: 'earn',
    label: 'Earn',
    prompts: [
      {
        icon: PiggyBank,
        label: 'Put idle money to work',
        text: 'deposit my idle USDC into the highest-yield lending vault on Polygon and report the rate.',
        skill: SKILL_URL
      },
      {
        icon: Calculator,
        label: 'Compare rates',
        text: 'compare the USDC earn options on Polygon and tell me which earns the most for low risk.',
        skill: SKILL_URL
      },
      {
        icon: ArrowDownToLine,
        label: 'Withdraw savings',
        text: 'withdraw my USDC from the lending vault back to my balance.',
        skill: SKILL_URL
      }
    ]
  },
  {
    id: 'pay',
    label: 'Pay per use',
    prompts: [
      {
        icon: Search,
        label: 'Paid web search',
        text: 'run a paid web search with Exa for the best-reviewed standing desks under $400.',
        skill: AGENTIC_SERVICES_SKILL_URL
      },
      {
        icon: Inbox,
        label: 'Give your agent an inbox',
        text: 'create an email inbox for yourself with AgentMail, then tell me its address.',
        skill: AGENTIC_SERVICES_SKILL_URL
      },
      {
        icon: Zap,
        label: 'Scrape a page',
        text: 'scrape https://polygon.technology with Firecrawl and summarize it in three lines.',
        skill: AGENTIC_SERVICES_SKILL_URL
      }
    ]
  },
  {
    id: 'move',
    label: 'Move money',
    prompts: [
      {
        icon: Send,
        label: 'Send money',
        text: 'send 5 USDC to 0x… and confirm when it lands.',
        skill: SKILL_URL
      },
      {
        icon: ArrowLeftRight,
        label: 'Swap tokens',
        text: 'swap 10 USDC to POL at the best rate and show me the new balances.',
        skill: SKILL_URL
      },
      {
        icon: TrendingUp,
        label: 'Bridge to another chain',
        text: 'bridge 10 USDC from Polygon to Base using the cheapest route and confirm it arrived.',
        skill: SKILL_URL
      }
    ]
  }
];

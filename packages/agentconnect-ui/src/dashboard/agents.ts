export const SKILL_URL = 'https://agentconnect.polygon.technology/polygon-agent-cli/SKILL.md';
export const POLYMARKET_SKILL_URL =
  'https://agentconnect.polygon.technology/polygon-polymarket/SKILL.md';
// x402 services catalog skill: pay-per-use prompts point the agent here so it
// knows which service routes to call (not the agentconnect/CLI skill).
export const AGENTIC_SERVICES_SKILL_URL = 'https://agent-discovery.polygon.org/SKILL.md';

// What the copy buttons put on the clipboard: works pasted into any agent.
export const buildPrompt = (text: string, skillUrl: string) => `Read ${skillUrl} and ${text}`;

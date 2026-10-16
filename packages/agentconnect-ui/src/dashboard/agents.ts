// The AgentPay skill: one entry point that routes to every use case, Polymarket included.
export const SKILL_URL = 'https://agents.polygon.technology/skill.md';
// x402 services catalog skill: pay-per-use prompts point the agent here so it
// knows which service routes to call (not the agentconnect/CLI skill).
export const AGENTIC_SERVICES_SKILL_URL = 'https://agent-discovery.polygon.org/SKILL.md';

// What the copy buttons put on the clipboard: works pasted into any agent.
export const buildPrompt = (text: string, skillUrl: string) => `Read ${skillUrl} and ${text}`;

import { Card } from '@polygonlabs/design-system';

import type { AgentContext } from '../types.js';

import { PromptRow } from '../../components/PromptRow.js';
import { buildPrompt, SKILL_URL } from '../agents.js';
import { ROW_LIST, SECTION_TITLE } from './styles.js';

interface AskAgentProps {
  ctx: AgentContext;
  id: string;
  prompts: string[];
  title?: string;
}

/**
 * "Ask your agent": prompts for what this page shows, each copied with the
 * skill link so it works pasted into any agent.
 */
export function AskAgent({ ctx, id, prompts, title = 'Ask your agent' }: AskAgentProps) {
  return (
    <div className="flex flex-col gap-3">
      <span className={SECTION_TITLE}>{title}</span>
      <Card className={ROW_LIST}>
        {prompts.map((t, i) => (
          <PromptRow
            key={t}
            text={t}
            copied={ctx.copied === `${id}${i}`}
            onCopy={() => ctx.copy(`${id}${i}`, buildPrompt(t, SKILL_URL))}
          />
        ))}
      </Card>
    </div>
  );
}

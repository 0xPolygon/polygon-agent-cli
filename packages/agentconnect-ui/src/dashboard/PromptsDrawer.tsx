import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Separator,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle
} from '@polygonlabs/design-system';

import type { AgentContext } from './types.js';

import { PromptRow } from '../components/PromptRow.js';
import { buildPrompt, SKILL_URL } from './agents.js';
import { MARKET_PROMPTS, OVERVIEW_PROMPTS, WALLET_PROMPTS } from './prompts.js';

export type PromptGroup = 'wallet' | 'markets';

const GROUPS: { id: PromptGroup; title: string; prompts: string[] }[] = [
  { id: 'wallet', title: 'Wallet prompts', prompts: [...OVERVIEW_PROMPTS, ...WALLET_PROMPTS] },
  { id: 'markets', title: 'Prediction markets prompts', prompts: MARKET_PROMPTS }
];

interface PromptsDrawerProps {
  open: boolean;
  onClose: () => void;
  initialGroup: PromptGroup;
  ctx: AgentContext;
}

interface PromptGroupsProps {
  initialGroup: PromptGroup;
  ctx: AgentContext;
}

// Mounted only while the sheet is open, so each opening starts from the page's own group.
function PromptGroups({ initialGroup, ctx }: PromptGroupsProps) {
  const [openGroup, setOpenGroup] = useState<PromptGroup | null>(initialGroup);
  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-4">
      {GROUPS.map((g) => (
        <Collapsible
          key={g.id}
          open={openGroup === g.id}
          onOpenChange={(open) => setOpenGroup(open ? g.id : null)}
          className="rounded-xl border border-border-normal"
        >
          <CollapsibleTrigger className="group flex h-12 w-full cursor-pointer items-center justify-between rounded-xl border-0 bg-transparent px-4 text-base font-bold text-primary">
            {g.title}
            <ChevronDown className="size-4 text-muted transition-transform duration-150 group-data-panel-open:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-150 data-ending-style:h-0 data-starting-style:h-0">
            <div className="flex flex-col gap-2 px-4 pb-4">
              <Separator className="mb-2" />
              {g.prompts.map((text, i) => (
                <PromptRow
                  key={text}
                  text={text}
                  copied={ctx.copied === `${g.id}${i}`}
                  onCopy={() => ctx.copy(`${g.id}${i}`, buildPrompt(text, SKILL_URL))}
                />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ))}
    </div>
  );
}

export function PromptsDrawer({ open, onClose, initialGroup, ctx }: PromptsDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="right"
        overlay={false}
        className="data-[side=right]:w-[380px] data-[side=right]:max-w-full data-[side=right]:sm:max-w-none data-[side=right]:md:w-[440px]"
      >
        <SheetHeader className="h-14 shrink-0 px-6 py-0">
          <SheetTitle className="text-xl">Agent prompts</SheetTitle>
        </SheetHeader>
        <PromptGroups initialGroup={initialGroup} ctx={ctx} />
      </SheetContent>
    </Sheet>
  );
}

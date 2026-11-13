import { useState } from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@polygonlabs/design-system';

import type { AgentContext } from '../types.js';

import { AgentPromptBox } from '../../components/AgentPromptBox.js';
import { SKILL_URL } from '../agents.js';
import { ResourcesGrid } from './ResourcesGrid.js';
import { SpendingLimits } from './SpendingLimits.js';

interface SettingsTabProps {
  address: string;
  ctx: AgentContext;
}

export function SettingsTab({ address, ctx }: SettingsTabProps) {
  const [limit, setLimit] = useState(200);
  const limitText = `change my agent wallet spending limit to $${limit}.`;
  return (
    <div className="flex flex-col gap-8 md:gap-10">
      <h2 className="m-0 text-page-title-sm font-bold md:text-page-title">Settings</h2>
      <Tabs defaultValue="limits">
        <TabsList>
          <TabsTrigger value="limits">Spending limits</TabsTrigger>
          <TabsTrigger value="resources">Resources</TabsTrigger>
        </TabsList>
        <TabsContent value="limits" className="pt-6">
          <SpendingLimits limit={limit} onChange={setLimit}>
            <AgentPromptBox {...ctx} id="limit" skill={SKILL_URL} text={limitText} />
          </SpendingLimits>
        </TabsContent>
        <TabsContent value="resources" className="pt-6">
          <ResourcesGrid address={address} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

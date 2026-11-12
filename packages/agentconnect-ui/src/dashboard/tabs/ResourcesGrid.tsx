import { ResourceCard } from '../../components/ResourceCard.js';
import { shortAddr } from '../../utils/format.js';
import { EXPLORER } from '../explorer.js';

interface ResourcesGridProps {
  address: string;
}

export function ResourcesGrid({ address }: ResourcesGridProps) {
  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      <ResourceCard
        title="View on Polygonscan"
        description={shortAddr(address)}
        href={`${EXPLORER}/address/${address}`}
      />
      <ResourceCard
        title="Docs"
        description="CLI reference, quickstart, and architecture"
        href="https://docs.polygon.technology/payment-services/agentic-payments/polygon-agent-cli"
      />
      <ResourceCard
        title="Add your service for agents"
        description="List your API as an x402 service agents can pay for per call"
        href="https://agent-discovery.polygon.org/discover"
      />
      <ResourceCard
        title="GitHub"
        description="Source code and issues for the Polygon Agent CLI"
        href="https://github.com/0xPolygon/polygon-agent-cli"
      />
    </div>
  );
}

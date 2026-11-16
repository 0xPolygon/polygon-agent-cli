import { Bot, Trash2 } from 'lucide-react';

import { Button, Card } from '@polygonlabs/design-system';

interface AgentRowProps {
  name: string;
  connectedOn: string;
  removing: boolean;
  onDisconnect: () => void;
}

export function AgentRow({ name, connectedOn, removing, onDisconnect }: AgentRowProps) {
  return (
    <Card variant="outline" className="flex items-center gap-3 h-10 rounded-xl px-3 py-0">
      <Bot className="size-4 shrink-0" aria-hidden />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate text-sm font-medium">{name}</span>
        <span className="shrink-0 text-xs text-muted">
          {removing ? 'Disconnecting…' : `Connected ${connectedOn}`}
        </span>
      </span>
      <Button
        type="button"
        variant="ghost"
        iconOnly
        disabled={removing}
        aria-label={`Disconnect ${name}`}
        onClick={onDisconnect}
      >
        <Trash2 className="stroke-[1.5]" />
      </Button>
    </Card>
  );
}

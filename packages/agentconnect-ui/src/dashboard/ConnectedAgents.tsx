import { Bot } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button, Card, Skeleton } from '@polygonlabs/design-system';

interface Agent {
  id: string;
  name: string;
  connectedAt: number;
}

const since = (unix: number) =>
  new Date(unix * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });

/** Agents connected through the sign-in flow, each with a way to cut it off. */
export function ConnectedAgents() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    void fetch('/api/agents')
      .then(async (r) => {
        if (!r.ok) throw new Error();
        setAgents(((await r.json()) as { agents: Agent[] }).agents);
      })
      .catch(() => setError("Couldn't load connected agents."));
  }, []);

  const disconnect = async (a: Agent) => {
    setRemoving(a.id);
    setError(null);
    try {
      const r = await fetch(`/api/agents/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
      if (!r.ok) throw new Error();
      setAgents((list) => list?.filter((x) => x.id !== a.id) ?? null);
    } catch {
      setError(`Couldn't disconnect ${a.name}. Try again.`);
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <span className="text-lg font-bold">Connected agents</span>
      <Card className="px-5 py-2 flex flex-col">
        {agents === null && !error ? (
          <Skeleton className="h-14 my-2 w-full rounded-xl" />
        ) : agents && agents.length === 0 ? (
          <span className="py-4 text-sm text-muted">
            No agents connected yet. When an agent asks to use your wallet, you&apos;ll approve it
            here.
          </span>
        ) : (
          agents?.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-3 py-3.5 border-b last:border-b-0 border-slate-100"
            >
              <Bot className="w-5 h-5 flex-shrink-0 text-muted" />
              <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                <span className="text-[15px] font-bold truncate">{a.name}</span>
                <span className="text-[13px] text-muted">Connected {since(a.connectedAt)}</span>
              </span>
              <Button
                type="button"
                variant="secondary"
                disabled={removing === a.id}
                onClick={() => void disconnect(a)}
              >
                {removing === a.id ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            </div>
          ))
        )}
        {error && <span className="py-3 text-sm text-destructive">{error}</span>}
      </Card>
    </div>
  );
}

import { useEffect, useState } from 'react';

import { Skeleton } from '@polygonlabs/design-system';

import { EmptyState } from '../components/EmptyState.js';
import { StatusBanner } from '../components/StatusBanner.js';
import { AgentRow } from './AgentRow.js';

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
    <div className="flex flex-col gap-2">
      <div className="mb-3">
        <StatusBanner>These are the agents that can interact with your wallet</StatusBanner>
      </div>
      {agents === null && !error ? (
        <Skeleton className="h-10 w-full rounded-xl" />
      ) : agents && agents.length === 0 ? (
        <EmptyState title="No agents connected yet">
          When an agent asks to use your wallet, you&apos;ll approve it here.
        </EmptyState>
      ) : agents ? (
        agents.map((a) => (
          <AgentRow
            key={a.id}
            name={a.name}
            connectedOn={since(a.connectedAt)}
            removing={removing === a.id}
            onDisconnect={() => void disconnect(a)}
          />
        ))
      ) : null}
      {error && <span className="text-sm text-destructive">{error}</span>}
    </div>
  );
}

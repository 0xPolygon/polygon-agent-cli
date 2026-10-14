import { Bot } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Panel, SectionTitle } from './ui.js';

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
      <SectionTitle>Connected agents</SectionTitle>
      <Panel pad="px-5 py-2" className="flex flex-col">
        {agents === null && !error ? (
          <div className="h-14 my-2 rounded-xl bg-[var(--slate-50)] animate-pulse" />
        ) : agents && agents.length === 0 ? (
          <span className="py-4 text-sm text-[var(--slate-500)]">
            No agents connected yet. When an agent asks to use your wallet, you&apos;ll approve it
            here.
          </span>
        ) : (
          agents?.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-3 py-3.5 border-b last:border-b-0 border-[var(--slate-100)]"
            >
              <Bot className="w-5 h-5 flex-shrink-0 text-[var(--slate-500)]" />
              <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                <span className="text-[15px] font-bold truncate">{a.name}</span>
                <span className="text-[13px] text-[var(--slate-500)]">
                  Connected {since(a.connectedAt)}
                </span>
              </span>
              <button
                type="button"
                disabled={removing === a.id}
                onClick={() => void disconnect(a)}
                className="btn btn-secondary btn-md bg-white"
              >
                {removing === a.id ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </div>
          ))
        )}
        {error && <span className="py-3 text-sm text-[var(--red-700)]">{error}</span>}
      </Panel>
    </div>
  );
}

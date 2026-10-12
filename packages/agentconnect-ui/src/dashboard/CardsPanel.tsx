import { Lock } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Card } from './credentials-api.js';

import {
  cardSessionStatus,
  CredentialsError,
  listCards,
  startCardSession
} from './credentials-api.js';
import { Panel } from './ui.js';

const SWATCH: Record<string, string> = {
  visa: 'var(--slate-900)',
  mastercard: 'var(--slate-700)',
  amex: 'var(--purple-600)'
};

const brandName = (b: string) => (b === 'amex' ? 'Amex' : b.charAt(0).toUpperCase() + b.slice(1));

type State = 'loading' | 'ready' | 'waiting' | 'unavailable' | 'error';

/**
 * "Connect a card securely": opens AgentCard's hosted page in a new tab (it
 * refuses to load in a frame), then watches the session until the card lands.
 */
export function CardsPanel({
  token,
  onFresh,
  onSaved
}: {
  token: string | null;
  // Ask the agent for a fresh link (shown when the token is missing or expired).
  onFresh: () => void;
  onSaved: (msg: string) => void;
}) {
  const [state, setState] = useState<State>(token ? 'loading' : 'ready');
  const [cards, setCards] = useState<Card[]>([]);
  const [error, setError] = useState<string | null>(null);
  const poll = useRef<ReturnType<typeof setTimeout>>();

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      setCards(await listCards(token));
      setState('ready');
    } catch (err) {
      setState(err instanceof CredentialsError && err.status === 503 ? 'unavailable' : 'error');
    }
  }, [token]);

  useEffect(() => {
    void refresh();
    return () => clearTimeout(poll.current);
  }, [refresh]);

  const connect = async () => {
    if (!token) {
      onFresh();
      return;
    }
    setError(null);
    // Open the tab inside the click so it isn't blocked as a popup.
    const tab = window.open('', '_blank');
    try {
      const session = await startCardSession(token);
      if (tab) tab.location.href = session.url;
      else window.location.assign(session.url);
      setState('waiting');
      const check = async () => {
        try {
          const s = await cardSessionStatus(token, session.sessionId);
          if (s.cardSaved) {
            await refresh();
            onSaved('Card connected');
            return;
          }
          if (s.status === 'expired') {
            setState('ready');
            setError('That link expired before a card was saved. Try again.');
            return;
          }
          poll.current = setTimeout(check, Math.max(3, s.pollInterval) * 1000);
        } catch {
          poll.current = setTimeout(check, 5000);
        }
      };
      poll.current = setTimeout(check, session.pollInterval * 1000);
    } catch (err) {
      tab?.close();
      if (err instanceof CredentialsError && err.status === 401) onFresh();
      else setError(err instanceof Error ? err.message : 'Could not start adding a card');
    }
  };

  return (
    <Panel className="flex flex-col gap-4" pad="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xl font-bold">Connect a card securely</span>
        <button
          type="button"
          onClick={() => void connect()}
          disabled={state === 'waiting' || state === 'unavailable'}
          className="btn btn-primary btn-lg"
        >
          <Lock className="w-4 h-4" />
          {state === 'waiting'
            ? 'Waiting for your card…'
            : token
              ? 'Connect a card'
              : 'Get a link from your agent'}
        </button>
      </div>
      {error && <span className="text-sm text-[var(--red-700)]">{error}</span>}
      {state === 'loading' ? (
        <div className="h-16 rounded-2xl bg-[var(--slate-50)] animate-pulse" />
      ) : (
        cards.map((c) => (
          <div
            key={c.id}
            className="border border-[var(--slate-200)] rounded-2xl px-4 py-3.5 flex items-center gap-3.5"
          >
            <span
              className="w-11 h-[30px] flex-shrink-0 rounded-md text-white text-[10px] font-bold flex items-center justify-center uppercase"
              style={{ background: SWATCH[c.brand] ?? 'var(--slate-700)' }}
            >
              {c.brand === 'american_express' ? 'AMEX' : c.brand.slice(0, 4)}
            </span>
            <span className="flex-1 min-w-0 text-[15px] font-bold">
              {brandName(c.brand)} ending {c.last4}
            </span>
          </div>
        ))
      )}
    </Panel>
  );
}

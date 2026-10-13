import { useEffect, useState } from 'react';

import { getAutoPayLimit, setAutoPayLimit } from './credentials-api.js';
import { AmountChips, Panel, SectionTitle } from './ui.js';

const CHOICES = [0, 25, 50, 100];

/** How much agents may pay with the saved card without asking. */
export function AutoPayPanel({ token }: { token: string | null }) {
  const [limit, setLimit] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    getAutoPayLimit(token)
      .then((c) => setLimit(c / 100))
      .catch(() => setError("Couldn't load this setting."));
  }, [token]);

  const pick = (dollars: number) => {
    if (!token) return;
    const before = limit;
    setLimit(dollars);
    setError(null);
    setAutoPayLimit(token, dollars * 100).catch(() => {
      setLimit(before);
      setError("Couldn't save. Try again.");
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <SectionTitle>Pay automatically up to</SectionTitle>
      <Panel pad="p-5" className="flex flex-col gap-4">
        <span className="text-sm text-[var(--slate-500)] leading-snug">
          Purchases at or under this go through with your saved card. Anything more waits for you to
          approve.
        </span>
        {token ? (
          <AmountChips
            values={CHOICES}
            value={limit ?? -1}
            onPick={pick}
            format={(v) => (v === 0 ? 'Always ask' : `$${v}`)}
          />
        ) : (
          <span className="text-sm text-[var(--slate-500)]">
            Open this page from a link your agent just sent to change it.
          </span>
        )}
        {error && <span className="text-sm text-[var(--red-700)]">{error}</span>}
      </Panel>
    </div>
  );
}

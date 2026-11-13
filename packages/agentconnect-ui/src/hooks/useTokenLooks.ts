import { useEffect, useState } from 'react';

import type { TokenLook } from '../dashboard/tokens.js';
import type { Holding } from '../indexer';

import { fetchTokenLooks } from '../dashboard/tokens.js';

// Holdings are read from Polygon, so the lookup is too.
const POLYGON = 137;

export function useTokenLooks(holdings: Holding[] | null): Record<string, TokenLook> {
  const [looks, setLooks] = useState<Record<string, TokenLook>>({});
  useEffect(() => {
    if (!holdings?.length) return;
    let live = true;
    void fetchTokenLooks(POLYGON, holdings).then((l) => live && setLooks(l));
    return () => {
      live = false;
    };
  }, [holdings]);
  return looks;
}

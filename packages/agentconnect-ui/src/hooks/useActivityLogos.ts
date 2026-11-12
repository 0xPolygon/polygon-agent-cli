import { useEffect, useState } from 'react';

import type { ActivityItem } from '../indexer';

import { logoAddresses, logosByAddress } from '../dashboard/derive.js';
import { fetchTokenLooks } from '../dashboard/tokens.js';

const POLYGON = 137;
// Newest rows first, so a busy wallet's older tokens just show the neutral placeholder.
const MAX_LOOKUPS = 30;

/** Logo per token address, only where the token list returns one for that exact address. */
export function useActivityLogos(items: ActivityItem[]): Record<string, string> {
  const [logos, setLogos] = useState<Record<string, string>>({});
  const key = logoAddresses({ items, limit: MAX_LOOKUPS }).join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    // An empty symbol keeps the lookup from borrowing a stablecoin logo by name.
    const tokens = key.split(',').map((address) => ({ address, symbol: '', name: '' }));
    void fetchTokenLooks(POLYGON, tokens).then((l) => live && setLogos(logosByAddress(l)));
    return () => {
      live = false;
    };
  }, [key]);
  return logos;
}

import { useState } from 'react';

import { SearchInput } from '@polygonlabs/design-system';

import type { Holding } from '../../indexer';
import type { Loadable } from '../types.js';

import { SectionHeader } from '../../components/SectionHeader.js';
import { HoldingsList } from './HoldingsList.js';

interface WalletTabProps {
  holdings: Loadable<Holding[]>;
}

export function WalletTab({ holdings }: WalletTabProps) {
  const [query, setQuery] = useState('');
  return (
    <div className="flex flex-col gap-3">
      <SectionHeader title="Your tokens">
        <SearchInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          aria-label="Search tokens"
          showKeyboardShortcut={false}
          className="w-full md:max-w-[300px]"
        />
      </SectionHeader>
      <HoldingsList holdings={holdings} query={query} />
    </div>
  );
}

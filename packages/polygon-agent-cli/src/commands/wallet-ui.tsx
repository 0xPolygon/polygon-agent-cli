import { Box, Text } from 'ink';
import React from 'react';

import { Header, Addr, KV } from '../ui/components.js';

export interface WalletInfo {
  name: string;
  address: string;
  chain: string;
  chainId: number;
}

export function WalletListUI({ wallets }: { wallets: WalletInfo[] }) {
  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      <Header sub="wallet list" />
      {wallets.length === 0 ? (
        <Box marginTop={1} gap={1}>
          <Text dimColor>No wallets found. Run:</Text>
          <Text>agent wallet login</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {/* Column headers */}
          <Box gap={0} marginBottom={1}>
            <Box width={14}>
              <Text bold>NAME</Text>
            </Box>
            <Box width={20}>
              <Text bold>ADDRESS</Text>
            </Box>
            <Text bold>CHAIN</Text>
          </Box>
          {wallets.map((w) => (
            <Box key={w.name} gap={0}>
              <Box width={14}>
                <Text bold>{w.name}</Text>
              </Box>
              <Box width={20}>
                <Addr address={w.address} />
              </Box>
              <Text dimColor>{w.chain}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

// Ink UI for wallet address
export function WalletAddressUI({
  name,
  address,
  chain,
  chainId
}: {
  name: string;
  address: string;
  chain: string;
  chainId: number;
}) {
  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      <Header sub={`wallet · ${name}`} />
      <Box flexDirection="column" marginTop={1} gap={1}>
        <KV k="address" v={address} accent />
        <KV k="chain" v={chain} />
        <KV k="chainId" v={String(chainId)} />
      </Box>
    </Box>
  );
}

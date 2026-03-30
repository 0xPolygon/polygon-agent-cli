import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import React, { useState, useEffect } from 'react';

import { loadWalletSession } from '../lib/storage.ts';
import { resolveNetwork, formatUnits } from '../lib/utils.ts';
import { Err } from '../ui/components.js';

// Get per-chain indexer URL
function getChainIndexerUrl(chainId: number): string {
  const chainNames: Record<number, string> = {
    137: 'polygon',
    80002: 'amoy',
    1: 'mainnet',
    42161: 'arbitrum',
    10: 'optimism',
    8453: 'base',
    43114: 'avalanche',
    56: 'bsc',
    100: 'gnosis'
  };
  return `https://${chainNames[chainId] || 'polygon'}-indexer.sequence.app`;
}

function shortAddr(address: string, head = 6, tail = 4): string {
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

interface BalanceEntry {
  symbol: string;
  balance: string;
  address: string; // contract address or '(native)'
}

interface BalancesUIProps {
  walletName: string;
  chainOverride?: string;
}

const COL_TOKEN = 14;
const COL_BALANCE = 26;

export function BalancesUI({ walletName, chainOverride }: BalancesUIProps) {
  const { exit } = useApp();
  const [loading, setLoading] = useState(true);
  const [walletAddress, setWalletAddress] = useState('');
  const [chainId, setChainId] = useState(0);
  const [chainName, setChainName] = useState('');
  const [balances, setBalances] = useState<BalanceEntry[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const session = await loadWalletSession(walletName);
        if (!session) throw new Error(`Wallet not found: ${walletName}`);

        const indexerKey =
          process.env.SEQUENCE_INDEXER_ACCESS_KEY ||
          session.projectAccessKey ||
          process.env.SEQUENCE_PROJECT_ACCESS_KEY;
        if (!indexerKey)
          throw new Error('Missing project access key (set SEQUENCE_PROJECT_ACCESS_KEY)');

        const network = resolveNetwork(chainOverride || session.chain || 'polygon');
        const nativeDecimals = network.nativeToken?.decimals ?? 18;
        const nativeSymbol = network.nativeToken?.symbol || 'POL';

        const { SequenceIndexer } = await import('@0xsequence/indexer');
        const indexer = new SequenceIndexer(getChainIndexerUrl(network.chainId), indexerKey);

        const [nativeRes, tokenRes] = await Promise.all([
          indexer.getNativeTokenBalance({ accountAddress: session.walletAddress }),
          indexer.getTokenBalances({ accountAddress: session.walletAddress, includeMetadata: true })
        ]);

        const rows: BalanceEntry[] = [
          {
            symbol: nativeSymbol,
            balance: formatUnits(BigInt(nativeRes?.balance?.balance || '0'), nativeDecimals),
            address: '(native)'
          }
        ];

        for (const b of tokenRes?.balances || []) {
          const sym = b.contractInfo?.symbol || 'ERC20';
          const dec = b.contractInfo?.decimals ?? 18;
          const addr = b.contractAddress ? shortAddr(b.contractAddress) : '';
          rows.push({ symbol: sym, balance: formatUnits(b.balance || '0', dec), address: addr });
        }

        setWalletAddress(session.walletAddress);
        setChainId(network.chainId);
        setChainName(network.name);
        setBalances(rows);
        setLoading(false);
        exit();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
        exit(new Error(e instanceof Error ? e.message : String(e)));
      }
    })();
  }, []);

  const addrShort = walletAddress ? shortAddr(walletAddress) : '';
  const divider = '─'.repeat(COL_TOKEN + COL_BALANCE + 20);

  return (
    <Box flexDirection="column" paddingBottom={1} paddingX={1}>
      {/* Header: Balances — 0xd502…c419 */}
      <Box gap={1}>
        <Text bold>Balances</Text>
        <Text dimColor>—</Text>
        <Text color="cyan">{addrShort || '…'}</Text>
      </Box>

      {loading && (
        <Box gap={1} marginTop={1} marginLeft={2}>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text dimColor>fetching…</Text>
        </Box>
      )}

      {!loading && !error && (
        <Box flexDirection="column" marginTop={1}>
          {/* Wallet / chain meta */}
          <Box marginLeft={2} gap={1}>
            <Text dimColor>Wallet:</Text>
            <Text>{walletAddress}</Text>
          </Box>
          <Box marginLeft={2} gap={1}>
            <Text dimColor>Chain: </Text>
            <Text color="cyan">
              {chainName} <Text dimColor>{chainId}</Text>
            </Text>
          </Box>

          {/* Table */}
          <Box flexDirection="column" marginTop={1} marginLeft={2}>
            {/* Column headers */}
            <Box gap={0}>
              <Box width={COL_TOKEN}>
                <Text bold>Token</Text>
              </Box>
              <Box width={COL_BALANCE}>
                <Text bold>Balance</Text>
              </Box>
              <Text bold>Address</Text>
            </Box>
            <Text dimColor>{divider}</Text>

            {/* Rows */}
            {balances.map((b) => (
              <Box key={b.symbol} gap={0}>
                <Box width={COL_TOKEN}>
                  <Text color="yellow" bold>
                    {b.symbol}
                  </Text>
                </Box>
                <Box width={COL_BALANCE}>
                  <Text color="green">{b.balance}</Text>
                </Box>
                <Text dimColor>{b.address}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      )}

      {error && <Err message={error} />}
    </Box>
  );
}

export interface SendUIProps {
  walletName: string;
  to: string;
  amount: string;
  symbol: string;
  broadcast: boolean;
  onExec: () => Promise<{ txHash?: string; explorerUrl?: string; walletAddress?: string }>;
}

export function SendUI({ walletName, to, amount, symbol, broadcast, onExec }: SendUIProps) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<'idle' | 'broadcasting' | 'done' | 'error'>('idle');
  const [txHash, setTxHash] = useState('');
  const [explorerUrl, setExplorerUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!broadcast) {
      exit();
      return;
    }
    setPhase('broadcasting');
    void (async () => {
      try {
        const result = await onExec();
        setTxHash(result.txHash || '');
        setExplorerUrl(result.explorerUrl || '');
        setPhase('done');
        exit();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setPhase('error');
        exit(new Error(msg));
      }
    })();
  }, []);

  const toDisplay = to;

  return (
    <Box flexDirection="column" paddingBottom={1} paddingX={1}>
      {/* Header */}
      <Box gap={1}>
        <Text bold>Send</Text>
        <Text dimColor>—</Text>
        <Text color="yellow" bold>
          {symbol}
        </Text>
        <Text dimColor>·</Text>
        <Text dimColor>{walletName}</Text>
      </Box>

      <Box flexDirection="column" marginTop={1} marginLeft={2}>
        {!broadcast && (
          <Box gap={1}>
            <Text color="yellow">◆</Text>
            <Text dimColor>Dry run — add --broadcast to execute</Text>
          </Box>
        )}

        {broadcast && (
          <Box flexDirection="column" gap={0}>
            {/* Token resolved */}
            <Box gap={1}>
              <Text color="green">✓</Text>
              <Text bold>{symbol}</Text>
              <Text dimColor>resolved</Text>
            </Box>

            {/* Broadcasting / confirmed */}
            {phase === 'broadcasting' && (
              <Box gap={1}>
                <Text color="cyan">
                  <Spinner type="dots" />
                </Text>
                <Text dimColor>Broadcasting transaction…</Text>
              </Box>
            )}

            {(phase === 'done' || phase === 'error') && (
              <Box gap={1}>
                {phase === 'done' ? <Text color="green">✓</Text> : <Text color="red">✗</Text>}
                <Text bold={phase === 'done'} color={phase === 'error' ? 'red' : undefined}>
                  {phase === 'done' ? 'Transaction confirmed' : 'Transaction failed'}
                </Text>
              </Box>
            )}
          </Box>
        )}

        {/* Result block */}
        {phase === 'done' && (
          <Box flexDirection="column" marginTop={1} gap={0}>
            <Box gap={1}>
              <Box width={11}>
                <Text dimColor>Amount:</Text>
              </Box>
              <Text color="green" bold>
                {amount} {symbol}
              </Text>
            </Box>
            <Box gap={1}>
              <Box width={11}>
                <Text dimColor>To:</Text>
              </Box>
              <Text>{toDisplay}</Text>
            </Box>
            {txHash && (
              <Box gap={1}>
                <Box width={11}>
                  <Text dimColor>Tx Hash:</Text>
                </Box>
                <Text dimColor>{txHash}</Text>
              </Box>
            )}
            {explorerUrl && (
              <Box gap={1}>
                <Box width={11}>
                  <Text dimColor>Explorer:</Text>
                </Box>
                <Text color="cyan">{explorerUrl}</Text>
              </Box>
            )}
          </Box>
        )}

        {phase === 'error' && <Err message={error} />}
      </Box>
    </Box>
  );
}

import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import React, { useState, useEffect } from 'react';

import { loadWalletSession } from '../lib/storage.ts';
import { resolveNetwork, formatUnits } from '../lib/utils.ts';
import { Header, KV, Err, Divider, DryRunBanner, TxResult } from '../ui/components.js';

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
  address: string;
}

interface BalancesUIProps {
  walletName: string;
  chainOverride?: string;
}

const COL_TOKEN = 10;
const COL_BALANCE = 22;

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

  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1} paddingBottom={1}>
      <Header sub={walletAddress ? `balances · ${shortAddr(walletAddress)}` : 'balances'} />

      {loading && (
        <Box gap={1} marginLeft={1}>
          <Text color="#8247e5">
            <Spinner type="dots" />
          </Text>
          <Text dimColor>fetching…</Text>
        </Box>
      )}

      {!loading && !error && (
        <Box flexDirection="column">
          <Box marginLeft={1} flexDirection="column" gap={0}>
            <KV k="wallet" v={walletAddress} />
            <KV k="chain" v={`${chainName}`} keyWidth={10} />
            <Box gap={1}>
              <Box width={10}>
                <Text dimColor>chain id</Text>
              </Box>
              <Text dimColor>{chainId}</Text>
            </Box>
          </Box>

          <Box flexDirection="column" marginTop={1} marginLeft={1}>
            <Box gap={0}>
              <Box width={COL_TOKEN}>
                <Text bold>Token</Text>
              </Box>
              <Box width={COL_BALANCE}>
                <Text bold>Balance</Text>
              </Box>
              <Text bold>Address</Text>
            </Box>
            <Divider width={COL_TOKEN + COL_BALANCE + 14} />

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

  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1} paddingBottom={1}>
      <Header sub={`send · ${symbol}`} />

      <Box flexDirection="column" marginLeft={1}>
        <KV k="wallet" v={walletName} />
        <KV k="to" v={to} />
        <KV k="amount" v={`${amount} ${symbol}`} accent />
      </Box>

      {!broadcast && <DryRunBanner />}

      {broadcast && (
        <Box flexDirection="column" marginTop={1} marginLeft={1} gap={0}>
          {phase === 'broadcasting' && (
            <Box gap={1}>
              <Text color="#8247e5">
                <Spinner type="dots" />
              </Text>
              <Text dimColor>Broadcasting…</Text>
            </Box>
          )}

          {phase === 'done' && (
            <Box gap={1}>
              <Text color="green">✓</Text>
              <Text bold>Transaction confirmed</Text>
            </Box>
          )}

          {phase === 'error' && (
            <Box gap={1}>
              <Text color="red">✗</Text>
              <Text color="red">Transaction failed</Text>
            </Box>
          )}
        </Box>
      )}

      {phase === 'done' && (
        <Box marginLeft={1}>
          <TxResult
            amount={amount}
            symbol={symbol}
            to={to}
            txHash={txHash}
            explorerUrl={explorerUrl}
          />
        </Box>
      )}

      {phase === 'error' && <Err message={error} />}
    </Box>
  );
}

export interface FundUIProps {
  walletName: string;
  walletAddress: string;
  chainId: number;
  fundingUrl: string;
}

export function FundUI({ walletName, walletAddress, chainId, fundingUrl }: FundUIProps) {
  const { exit } = useApp();

  useEffect(() => {
    exit();
  }, []);

  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1} paddingBottom={1}>
      <Header sub="fund" />
      <Box flexDirection="column" marginLeft={1} gap={0}>
        <KV k="wallet" v={walletName} />
        <KV k="address" v={walletAddress} keyWidth={10} />
        <KV k="chain id" v={String(chainId)} keyWidth={10} />
      </Box>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="#8247e5"
        paddingX={2}
        paddingY={0}
        marginY={1}
      >
        <Text dimColor>open in browser to fund wallet</Text>
        <Text color="cyan" wrap="wrap">
          {fundingUrl}
        </Text>
      </Box>
      <Box marginLeft={1} gap={1}>
        <Text color="#8247e5">→</Text>
        <Text dimColor>swap any token to your wallet via Trails</Text>
      </Box>
    </Box>
  );
}

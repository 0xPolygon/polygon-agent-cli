import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import React, { useState, useEffect } from 'react';

import type { TokenBalance } from '@0xsequence/typescript-sdk';

import { findNetworkById } from '@0xsequence/typescript-sdk';

import { getOmsClient } from '../lib/oms-client.ts';
import { loadOmsWalletPointer } from '../lib/storage.ts';
import { resolveNetwork, formatUnits } from '../lib/utils.ts';
import { Header, KV, Err, Divider, DryRunBanner, TxResult } from '../ui/components.js';

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
        const pointer = await loadOmsWalletPointer(walletName);
        if (!pointer)
          throw new Error(`Wallet not found: ${walletName}. Run: polygon-agent wallet login`);
        const addr = pointer.walletAddress;

        const network = resolveNetwork(chainOverride || 'polygon');
        const nativeDecimals = network.nativeToken?.decimals ?? 18;
        const nativeSymbol = network.nativeToken?.symbol || 'POL';

        const omsNetwork = findNetworkById(network.chainId);
        if (!omsNetwork) throw new Error(`Unsupported chain for OMS indexer: ${network.chainId}`);
        const oms = getOmsClient(walletName);

        const [nativeRes, tokenRes] = await Promise.all([
          oms.indexer.getNativeTokenBalance({ network: omsNetwork, walletAddress: addr }),
          oms.indexer.getTokenBalances({
            network: omsNetwork,
            walletAddress: addr,
            includeMetadata: true
          })
        ]);

        const rows: BalanceEntry[] = [
          {
            symbol: nativeSymbol,
            balance: formatUnits(BigInt(nativeRes?.balance || '0'), nativeDecimals),
            address: '(native)'
          }
        ];

        for (const b of (tokenRes?.balances || []) as TokenBalance[]) {
          const sym = b.contractInfo?.symbol || 'ERC20';
          const dec = b.contractInfo?.decimals ?? 18;
          const tokenAddr = b.contractAddress ? shortAddr(b.contractAddress) : '';
          rows.push({
            symbol: sym,
            balance: formatUnits(b.balance || '0', dec),
            address: tokenAddr
          });
        }

        setWalletAddress(addr);
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

import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import React from 'react';

export const POLY = '#8247e5'; // Polygon brand purple

export type StepStatus = 'pending' | 'active' | 'done' | 'error';

// ◆ Polygon Agent header with separator
export function Header({ sub }: { sub?: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={1}>
        <Text bold color={POLY}>
          ◆
        </Text>
        <Text bold>Polygon Agent</Text>
        {sub && <Text dimColor>· {sub}</Text>}
      </Box>
      <Text dimColor>{'─'.repeat(40)}</Text>
    </Box>
  );
}

// Step line with animated spinner → checkmark
export function Step({
  label,
  status,
  detail
}: {
  label: string;
  status: StepStatus;
  detail?: string;
}) {
  const icon =
    status === 'active' ? (
      <Text color={POLY}>
        <Spinner type="dots" />
      </Text>
    ) : status === 'done' ? (
      <Text color="green">✓</Text>
    ) : status === 'error' ? (
      <Text color="red">✗</Text>
    ) : (
      <Text dimColor>·</Text>
    );

  return (
    <Box gap={1}>
      <Box width={2}>{icon}</Box>
      <Text
        bold={status === 'done' || status === 'active'}
        dimColor={status === 'pending'}
        color={status === 'error' ? 'red' : undefined}
      >
        {label}
      </Text>
      {detail && <Text dimColor> {detail}</Text>}
    </Box>
  );
}

// Key → value row
export function KV({
  k,
  v,
  accent,
  keyWidth = 10
}: {
  k: string;
  v: string;
  accent?: boolean;
  keyWidth?: number;
}) {
  return (
    <Box gap={1}>
      <Box width={keyWidth}>
        <Text dimColor>{k}</Text>
      </Box>
      <Text color={accent ? 'cyan' : undefined} bold={accent}>
        {v}
      </Text>
    </Box>
  );
}

// Bordered URL display box
export function UrlBox({ href, label = 'open in browser' }: { href: string; label?: string }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={POLY}
      paddingX={2}
      paddingY={0}
      marginY={1}
    >
      <Text dimColor>{label}</Text>
      <Text color="cyan" wrap="wrap">
        {href}
      </Text>
    </Box>
  );
}

// Inline link line
export function Link({ href }: { href: string }) {
  return (
    <Box gap={1}>
      <Text color={POLY}>↗</Text>
      <Text color="cyan">{href}</Text>
    </Box>
  );
}

// Truncated address: 0x1234···5678
export function Addr({ address }: { address: string }) {
  const s = `${address.slice(0, 6)}···${address.slice(-4)}`;
  return <Text color="cyan">{s}</Text>;
}

// 6-digit code: individual bordered digit slots
export function CodeDisplay({ code, max = 6 }: { code: string; max?: number }) {
  const chars = Array.from({ length: max }, (_, i) => (i < code.length ? code[i] : ''));
  return (
    <Box gap={1}>
      {chars.map((c, i) => (
        <Box
          key={i}
          width={3}
          justifyContent="center"
          borderStyle="round"
          borderColor={c ? POLY : 'gray'}
        >
          <Text color={c ? POLY : undefined} bold={Boolean(c)} dimColor={!c}>
            {c || '·'}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

// Token balance row
export function TokenRow({
  symbol,
  balance,
  usd
}: {
  symbol: string;
  balance: string;
  usd?: string;
}) {
  return (
    <Box gap={2}>
      <Box width={8}>
        <Text bold>{symbol}</Text>
      </Box>
      <Box width={14}>
        <Text>{balance}</Text>
      </Box>
      {usd && <Text dimColor>{usd}</Text>}
    </Box>
  );
}

// Error line
export function Err({ message }: { message: string }) {
  return (
    <Box gap={1} marginTop={1}>
      <Text color="red">✗</Text>
      <Text color="red">{message}</Text>
    </Box>
  );
}

// Divider
export function Divider({ width = 40 }: { width?: number }) {
  return <Text dimColor>{'─'.repeat(width)}</Text>;
}

// Hint / next step
export function Hint({ children }: { children: string }) {
  return (
    <Box marginTop={1} gap={1}>
      <Text color={POLY}>→</Text>
      <Text dimColor>{children}</Text>
    </Box>
  );
}

// Section label
export function Label({ children }: { children: string }) {
  return <Text dimColor>{children.toUpperCase()}</Text>;
}

// Dry-run notice
export function DryRunBanner() {
  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={2} paddingY={0} marginTop={1} gap={2}>
      <Text color="yellow">⚡ Dry run</Text>
      <Text dimColor>add --broadcast to execute</Text>
    </Box>
  );
}

// Transaction confirmed result block
export function TxResult({
  amount,
  symbol,
  to,
  txHash,
  explorerUrl
}: {
  amount?: string;
  symbol?: string;
  to?: string;
  txHash?: string;
  explorerUrl?: string;
}) {
  return (
    <Box flexDirection="column" marginTop={1} gap={0}>
      {amount && symbol && <KV k="Amount" v={`${amount} ${symbol}`} accent />}
      {to && <KV k="To" v={to} />}
      {txHash && <KV k="Tx hash" v={txHash} />}
      {explorerUrl && (
        <Box marginTop={1}>
          <Link href={explorerUrl} />
        </Box>
      )}
    </Box>
  );
}

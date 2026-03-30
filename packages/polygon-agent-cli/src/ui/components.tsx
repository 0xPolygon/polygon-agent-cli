import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import React from 'react';

export type StepStatus = 'pending' | 'active' | 'done' | 'error';

// ◆ Polygon Agent header
export function Header({ sub }: { sub?: string }) {
  return (
    <Box marginBottom={1} gap={1}>
      <Text bold color="magenta">
        ◆
      </Text>
      <Text bold>Polygon Agent</Text>
      {sub && <Text dimColor>· {sub}</Text>}
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
      <Text color="cyan">
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
        color={
          status === 'error'
            ? 'red'
            : status === 'done'
              ? undefined
              : status === 'active'
                ? undefined
                : undefined
        }
      >
        {label}
      </Text>
      {detail && <Text dimColor> {detail}</Text>}
    </Box>
  );
}

// Key → value row
export function KV({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <Box gap={2}>
      <Box width={10}>
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
      borderColor="cyan"
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

// Clickable URL line (inline, no border)
export function Link({ href }: { href: string }) {
  return (
    <Box gap={1}>
      <Text dimColor>↗</Text>
      <Text color="cyan">{href}</Text>
    </Box>
  );
}

// Truncated address: 0x1234···5678
export function Addr({ address }: { address: string }) {
  const s = `${address.slice(0, 6)}···${address.slice(-4)}`;
  return <Text>{s}</Text>;
}

// 6-digit code display: individual styled digit slots
export function CodeDisplay({ code, max = 6 }: { code: string; max?: number }) {
  const chars = Array.from({ length: max }, (_, i) => (i < code.length ? code[i] : '·'));
  return (
    <Box gap={1}>
      {chars.map((c, i) => (
        <Box key={i} width={3} justifyContent="center">
          <Text color={c === '·' ? undefined : 'magenta'} bold={c !== '·'} dimColor={c === '·'}>
            {c}
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

// Error line (no border — matches plain text aesthetic)
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

// Hint text (next step guidance)
export function Hint({ children }: { children: string }) {
  return (
    <Box marginTop={1} gap={1}>
      <Text dimColor>→</Text>
      <Text dimColor>{children}</Text>
    </Box>
  );
}

// Section label (dimmed caps)
export function Label({ children }: { children: string }) {
  return <Text dimColor>{children.toUpperCase()}</Text>;
}

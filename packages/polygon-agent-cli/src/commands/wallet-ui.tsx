import { Box, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import React, { useState, useEffect, useRef } from 'react';

import {
  generateX25519Keypair,
  bytesToHex,
  computeCodeHash,
  decryptSession
} from '@polygonlabs/agent-shared';

import { RelayClient, RelayCodeError } from '../lib/relay-client.ts';
import {
  saveWalletSession,
  saveWalletRequest,
  deleteWalletRequest,
  sessionPayloadToWalletSession
} from '../lib/storage.ts';
import { normalizeChain, resolveNetwork, formatUnits } from '../lib/utils.ts';
import { Header, Step, UrlBox, Addr, CodeDisplay, Hint, Err, KV } from '../ui/components.js';

// Session permission args interface (subset used for URL building)
interface SessionPermissionArgs {
  'native-limit'?: string;
  'usdc-limit'?: string;
  'usdt-limit'?: string;
  'token-limit'?: string[];
  contract?: string[];
  'usdc-to'?: string;
  'usdc-amount'?: string;
  'access-key'?: string;
}

const AUTO_WHITELISTED_CONTRACTS = [
  '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', // ERC-8004 IdentityRegistry
  '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63', // ERC-8004 ReputationRegistry
  '0xABAAd93EeE2a569cF0632f39B10A9f5D734777ca', // ValueForwarder (required for send native POL)

  // Polygon mainnet (chainId 137) — ERC-20 token contracts (needed for approve() in deposits/swaps)
  '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // USDC (native)
  '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', // USDT
  '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', // WETH

  // Polygon mainnet (chainId 137) — yield vaults
  '0x794a61358d6845594f94dc1db02a252b5b4814ad', // Aave V3 Pool (all markets)
  '0x781fb7f6d845e3be129289833b04d43aa8558c42', // Morpho Compound USDC
  '0xf5c81d25ee174d83f1fd202ca94ae6070d073ccf', // Morpho Compound WETH
  '0x3f33f9f7e2d7cfbcbdf8ea8b870a6e3d449664c2', // Morpho Compound POL

  // Katana (chainId 747474) — Morpho vaults
  '0x1ecdc3f2b5e90bfb55ff45a7476ff98a8957388e', // Gauntlet USDT (~$97M TVL)
  '0x61d4f9d3797ba4da152238c53a6f93fb665c3c1d', // Steakhouse Prime USDC (~$54M TVL)
  '0xfade0c546f44e33c134c4036207b314ac643dc2e', // Yearn OG ETH (~$16M TVL)
  '0xce2b8e464fc7b5e58710c24b7e5ebfb6027f29d7', // Yearn OG USDC (~$16M TVL)
  '0xe4248e2105508fcbad3fe95691551d1af14015f7', // Gauntlet USDC (~$8M TVL)
  '0x8ed68f91afbe5871dce31ae007a936ebe8511d47', // Yearn OG USDT (~$8M TVL)
  '0xc5e7ab07030305fc925175b25b93b285d40dcdff', // Gauntlet WETH (~$6M TVL)
  '0xef77f8c53af95f3348cee0fb2a02ee02ab9cdca5' // Hyperithm vbUSDC Apex (~$3M TVL)
];

function applySessionPermissionParams(url: URL, argv: SessionPermissionArgs): void {
  const usdcTo = argv['usdc-to'];
  const usdcAmount = argv['usdc-amount'];
  if (usdcTo || usdcAmount) {
    if (!usdcTo || !usdcAmount) throw new Error('Must provide both --usdc-to and --usdc-amount');
    url.searchParams.set('erc20', 'usdc');
    url.searchParams.set('erc20To', usdcTo);
    url.searchParams.set('erc20Amount', usdcAmount);
  }

  const nativeLimit = argv['native-limit'];
  const usdcLimit = argv['usdc-limit'] || '50';
  const usdtLimit = argv['usdt-limit'];
  if (nativeLimit) url.searchParams.set('nativeLimit', nativeLimit);
  url.searchParams.set('usdcLimit', usdcLimit);
  if (usdtLimit) url.searchParams.set('usdtLimit', usdtLimit);

  const tokenLimits = (argv['token-limit'] || [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  if (tokenLimits.length) url.searchParams.set('tokenLimits', tokenLimits.join(','));

  const userContracts = (argv.contract || []).map((s) => String(s || '').trim()).filter(Boolean);
  const allContracts = [...new Set([...AUTO_WHITELISTED_CONTRACTS, ...userContracts])];
  url.searchParams.set('contracts', allContracts.join(','));
}

export type WalletCreatePhase =
  | 'registering'
  | 'waiting'
  | 'code'
  | 'nocode'
  | 'linking'
  | 'done'
  | 'balances'
  | 'error';

interface BalanceRow {
  symbol: string;
  balance: string;
  usd?: string;
}

export interface WalletCreateUIProps {
  name: string;
  chain: string;
  timeout: number;
  argv: SessionPermissionArgs & { 'access-key'?: string };
  tty?: boolean;
  onComplete?: (walletAddress: string, chainId: number, chain: string) => void;
  onError?: (message: string) => void;
}

// Renders nothing but registers Ink's keystroke listener so the user can type
// the 6-digit approval code. Extracted so it can be conditionally mounted —
// useInput() triggers raw-mode setup on stdin which crashes in non-TTY contexts.
function CodeInputCapture({
  phase,
  setCode
}: {
  phase: WalletCreatePhase;
  setCode: React.Dispatch<React.SetStateAction<string>>;
}) {
  useInput((input, key) => {
    if (phase !== 'code') return;
    if (/^\d+$/.test(input)) {
      setCode((prev) => (prev + input).slice(0, 6));
    }
    if (key.backspace || key.delete) {
      setCode((prev) => prev.slice(0, -1));
    }
  });
  return null;
}

export function WalletCreateUI({
  name,
  chain,
  timeout,
  argv,
  tty = true,
  onComplete,
  onError
}: WalletCreateUIProps) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<WalletCreatePhase>('registering');
  const [url, setUrl] = useState('');
  const [rid, setRid] = useState('');
  const [address, setAddress] = useState('');
  const [walletChain, setWalletChain] = useState('');
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState('');
  const [error, setError] = useState('');
  const [balances, setBalances] = useState<BalanceRow[]>([]);
  const stateRef = useRef<{ rid: string; cliSk: Uint8Array; relay: RelayClient } | null>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    void (async () => {
      try {
        const normalizedChain = normalizeChain(chain);
        const connectorBase = (
          process.env.SEQUENCE_ECOSYSTEM_CONNECTOR_URL || 'https://agentconnect.polygon.technology'
        ).replace(/\/$/, '');

        const { secretKey: cliSk, publicKey: cliPk } = generateX25519Keypair();
        const cliPkHex = bytesToHex(cliPk);
        const cliSkHex = bytesToHex(cliSk);

        const relay = new RelayClient(connectorBase);
        const rid = await relay.createRequest(cliPkHex);

        const projectAccessKey = argv['access-key'] || process.env.SEQUENCE_PROJECT_ACCESS_KEY;

        const createdAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

        await saveWalletRequest(rid, {
          rid,
          walletName: name,
          chain: normalizedChain,
          createdAt,
          expiresAt,
          publicKeyB64u: '',
          privateKeyB64u: '',
          projectAccessKey: projectAccessKey || null,
          cliSkHex
        });

        const urlObj = new URL(`${connectorBase}/link`);
        urlObj.searchParams.set('rid', rid);
        urlObj.searchParams.set('wallet', name);
        urlObj.searchParams.set('chain', normalizedChain);
        if (projectAccessKey) urlObj.searchParams.set('accessKey', projectAccessKey);
        applySessionPermissionParams(urlObj, argv);
        const fullUrl = urlObj.toString();

        stateRef.current = { rid, cliSk, relay };
        setUrl(fullUrl);
        setRid(rid);
        setPhase('waiting');

        try {
          const { default: open } = await import('open');
          await open(fullUrl);
        } catch {
          // ignore
        }

        await relay.waitForReady(rid, timeout * 1000, 2_000);
        // Non-TTY: can't collect code interactively — show import command and exit
        if (!tty) {
          setPhase('nocode');
          exit();
          return;
        }
        setPhase('code');
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setPhase('error');
        onError?.(msg);
        exit(new Error(msg));
      }
    })();
  }, []);

  useEffect(() => {
    if (phase === 'code' && code.length === 6 && !submittingRef.current) {
      submittingRef.current = true;
      setCodeError('');
      void (async () => {
        try {
          setPhase('linking');
          const { rid, cliSk, relay } = stateRef.current!;
          const codeHashHex = bytesToHex(computeCodeHash(rid, code));
          const encrypted = await relay.retrieve(rid, codeHashHex);
          const payload = decryptSession(encrypted, cliSk, code, rid);
          const session = sessionPayloadToWalletSession(payload);
          await saveWalletSession(name, session);
          await deleteWalletRequest(stateRef.current!.rid);
          setAddress(session.walletAddress);
          setWalletChain(session.chain);
          setPhase('done');
          onComplete?.(session.walletAddress, session.chainId, session.chain);
          // Fetch balances after a short delay then exit
          setPhase('balances');
          try {
            const accessKey =
              process.env.SEQUENCE_INDEXER_ACCESS_KEY ||
              session.projectAccessKey ||
              process.env.SEQUENCE_PROJECT_ACCESS_KEY;
            if (accessKey) {
              const network = resolveNetwork(session.chain);
              const nativeSymbol = network.nativeToken?.symbol || 'POL';
              const nativeDecimals = network.nativeToken?.decimals ?? 18;
              const { SequenceIndexer } = await import('@0xsequence/indexer');
              const chainNames: Record<number, string> = {
                137: 'polygon',
                80002: 'amoy',
                1: 'mainnet',
                42161: 'arbitrum',
                10: 'optimism',
                8453: 'base'
              };
              const chainSlug = chainNames[network.chainId] || 'polygon';
              const indexer = new SequenceIndexer(
                `https://${chainSlug}-indexer.sequence.app`,
                accessKey
              );
              const [nativeRes, tokenRes] = await Promise.all([
                indexer.getNativeTokenBalance({ accountAddress: session.walletAddress }),
                indexer.getTokenBalances({
                  accountAddress: session.walletAddress,
                  includeMetadata: true
                })
              ]);
              const rows: BalanceRow[] = [
                {
                  symbol: nativeSymbol,
                  balance: formatUnits(BigInt(nativeRes?.balance?.balance || '0'), nativeDecimals)
                }
              ];
              for (const b of tokenRes?.balances || []) {
                const sym = b.contractInfo?.symbol || 'ERC20';
                const dec = b.contractInfo?.decimals ?? 18;
                const bal = formatUnits(b.balance || '0', dec);
                if (parseFloat(bal) > 0) rows.push({ symbol: sym, balance: bal });
              }
              setBalances(rows);
            }
          } catch {
            // balance fetch failure is non-fatal
          }
          setPhase('done');
          exit();
        } catch (e: unknown) {
          if (e instanceof RelayCodeError && e.attemptsRemaining > 0) {
            submittingRef.current = false;
            setCode('');
            setCodeError(
              `Incorrect code — ${e.attemptsRemaining} attempt${e.attemptsRemaining === 1 ? '' : 's'} remaining`
            );
            setPhase('code');
          } else {
            const msg = e instanceof Error ? e.message : String(e);
            setError(msg);
            setPhase('error');
            onError?.(msg);
            exit(new Error(msg));
          }
        }
      })();
    }
  }, [phase, code]);

  const regStatus: 'active' | 'done' | 'error' =
    phase === 'registering' ? 'active' : phase === 'error' && !url ? 'error' : 'done';

  const waitStatus: 'pending' | 'active' | 'done' | 'error' =
    phase === 'registering'
      ? 'pending'
      : phase === 'waiting'
        ? 'active'
        : ['code', 'nocode', 'linking', 'done'].includes(phase)
          ? 'done'
          : phase === 'error'
            ? 'error'
            : 'pending';

  const linkStatus: 'pending' | 'active' | 'done' | 'error' = [
    'registering',
    'waiting',
    'code',
    'nocode'
  ].includes(phase)
    ? 'pending'
    : phase === 'linking'
      ? 'active'
      : phase === 'done'
        ? 'done'
        : phase === 'error'
          ? 'error'
          : 'pending';

  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      {/* Only listen for keystrokes when we have a TTY. Mounting useInput()
          in a non-TTY context triggers Ink's raw-mode setup, which throws
          "Raw mode is not supported on the current process.stdin". */}
      {tty && <CodeInputCapture phase={phase} setCode={setCode} />}

      <Header sub={`wallet create · ${chain}`} />

      {/* Steps */}
      <Step label="Register relay session" status={regStatus} />
      <Step label="Approve in browser" status={waitStatus} />
      <Step label="Link wallet" status={linkStatus} />

      {/* URL box — shown during waiting/code/nocode/linking */}
      {url && ['waiting', 'code', 'nocode', 'linking'].includes(phase) && (
        <UrlBox href={url} label="open in browser to continue" />
      )}

      {/* Non-TTY: browser approved but can't enter code interactively */}
      {phase === 'nocode' && (
        <Box flexDirection="column" marginTop={1} paddingX={1} gap={1}>
          <Box gap={1}>
            <Text color="green">✓</Text>
            <Text bold>Browser approved — enter your code:</Text>
          </Box>
          <Box gap={1}>
            <Text dimColor>run</Text>
            <Text
              color="cyan"
              bold
            >{`polygon-agent wallet import --rid ${rid} --code <6-digit-code>`}</Text>
          </Box>
        </Box>
      )}

      {/* Code entry — shown during code phase (TTY only) */}
      {phase === 'code' && (
        <Box flexDirection="column" marginTop={1} paddingX={1}>
          <Box
            borderStyle="round"
            borderColor="#8247e5"
            flexDirection="column"
            paddingX={3}
            paddingY={1}
            gap={1}
          >
            <Text dimColor>Enter the 6-digit code shown in your browser</Text>
            <CodeDisplay code={code} />
            {codeError && <Text color="red">{codeError}</Text>}
          </Box>
        </Box>
      )}

      {/* Linking spinner detail */}
      {phase === 'linking' && (
        <Box marginLeft={4} marginTop={1}>
          <Text dimColor>decrypting session...</Text>
        </Box>
      )}

      {/* Balance fetching spinner */}
      {phase === 'balances' && (
        <Box marginLeft={4} marginTop={1} gap={1}>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text dimColor>fetching wallet balances...</Text>
        </Box>
      )}

      {/* Success */}
      {phase === 'done' && (
        <Box flexDirection="column" marginTop={1} marginLeft={2} gap={0}>
          <Box gap={1}>
            <Text color="green">✓</Text>
            <Text bold>Wallet ready</Text>
            <Text dimColor>·</Text>
            <Text color="cyan">{name}</Text>
          </Box>
          <Box flexDirection="column" marginTop={1} gap={0}>
            <KV k="address" v={address} accent />
            <KV k="chain" v={walletChain} />
          </Box>
          {balances.length > 0 && (
            <Box flexDirection="column" marginTop={1} gap={0}>
              <Text dimColor>{'─'.repeat(36)}</Text>
              {balances.map((b) => (
                <Box key={b.symbol} gap={0}>
                  <Box width={8}>
                    <Text color="yellow" bold>
                      {b.symbol}
                    </Text>
                  </Box>
                  <Text color="green">{b.balance}</Text>
                </Box>
              ))}
            </Box>
          )}
          <Hint>polygon-agent balances</Hint>
        </Box>
      )}

      {phase === 'error' && <Err message={error} />}
    </Box>
  );
}

// Ink UI for wallet list
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
          <Text>polygon-agent wallet create</Text>
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

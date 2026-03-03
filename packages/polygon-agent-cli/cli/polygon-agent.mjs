#!/usr/bin/env node

// Polygon Agent Kit - Main CLI Entry Point
// Agent-first blockchain toolkit for Polygon

const cmd = process.argv[2];
const subCmd = process.argv[3];

if (cmd === '--version' || cmd === '-v') {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const { version } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  console.log(version);
  process.exit(0);
}

async function main() {
  try {
    // === SETUP ===
    // `setup` is a shorthand alias for `builder setup`
    if (cmd === 'setup' || (cmd === 'builder' && subCmd === 'setup')) {
      const { builderSetup } = await import('./commands/builder.mjs');
      await builderSetup();

      // === WALLET ===
    } else if (cmd === 'wallet' && subCmd === 'create') {
      const { walletCreate, walletCreateAndWait } = await import('./commands/wallet.mjs');
      // --wait is now the default (recommended flow). Use --no-wait for manual URL-only mode.
      if (process.argv.includes('--no-wait')) {
        await walletCreate();
      } else {
        await walletCreateAndWait();
      }
    } else if (cmd === 'wallet' && (subCmd === 'start-session' || subCmd === 'import')) {
      const { walletStartSession } = await import('./commands/wallet.mjs');
      await walletStartSession();
    } else if (cmd === 'wallet' && subCmd === 'list') {
      const { walletList } = await import('./commands/wallet.mjs');
      await walletList();
    } else if (cmd === 'wallet' && subCmd === 'address') {
      const { walletAddress } = await import('./commands/wallet.mjs');
      await walletAddress();
    } else if (cmd === 'wallet' && subCmd === 'remove') {
      const { walletRemove } = await import('./commands/wallet.mjs');
      await walletRemove();

      // === OPERATIONS ===
    } else if (cmd === 'balances') {
      const { balances } = await import('./commands/operations.mjs');
      await balances();
    } else if (cmd === 'send') {
      const { send } = await import('./commands/operations.mjs');
      await send();
    } else if (cmd === 'send-native') {
      const { sendNative } = await import('./commands/operations.mjs');
      await sendNative();
    } else if (cmd === 'send-token') {
      const { sendToken } = await import('./commands/operations.mjs');
      await sendToken();
    } else if (cmd === 'swap') {
      const { swap } = await import('./commands/operations.mjs');
      await swap();
    } else if (cmd === 'fund') {
      const { fund } = await import('./commands/operations.mjs');
      await fund();
    } else if (cmd === 'deposit') {
      const { deposit } = await import('./commands/operations.mjs');
      await deposit();
    } else if (cmd === 'x402-pay') {
      const { x402Pay } = await import('./commands/operations.mjs');
      await x402Pay();

      // === AGENT SUBCOMMAND GROUP ===
    } else if (cmd === 'agent' && subCmd === 'register') {
      const { registerAgent } = await import('./commands/registry.mjs');
      await registerAgent();
    } else if (cmd === 'agent' && subCmd === 'wallet') {
      const { getAgentWallet } = await import('./commands/registry.mjs');
      await getAgentWallet();
    } else if (cmd === 'agent' && subCmd === 'metadata') {
      const { getMetadata } = await import('./commands/registry.mjs');
      await getMetadata();
    } else if (cmd === 'agent' && subCmd === 'reputation') {
      const { getReputation } = await import('./commands/registry.mjs');
      await getReputation();
    } else if (cmd === 'agent' && subCmd === 'feedback') {
      const { giveFeedback } = await import('./commands/registry.mjs');
      await giveFeedback();
    } else if (cmd === 'agent' && subCmd === 'reviews') {
      const { readAllFeedback } = await import('./commands/registry.mjs');
      await readAllFeedback();

      // === LEGACY ALIASES (backward compatibility) ===
    } else if (cmd === 'register') {
      const { registerAgent } = await import('./commands/registry.mjs');
      await registerAgent();
    } else if (cmd === 'agent-wallet') {
      const { getAgentWallet } = await import('./commands/registry.mjs');
      await getAgentWallet();
    } else if (cmd === 'agent-metadata') {
      const { getMetadata } = await import('./commands/registry.mjs');
      await getMetadata();
    } else if (cmd === 'reputation') {
      const { getReputation } = await import('./commands/registry.mjs');
      await getReputation();
    } else if (cmd === 'give-feedback') {
      const { giveFeedback } = await import('./commands/registry.mjs');
      await giveFeedback();
    } else if (cmd === 'read-feedback') {
      const { readAllFeedback } = await import('./commands/registry.mjs');
      await readAllFeedback();
    } else {
      showHelp();
    }
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message, stack: err.stack }, null, 2));
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
Polygon Agent Kit - Agent-first blockchain toolkit for Polygon

Usage: polygon-agent <command> [options]

SETUP:
  setup --name <name>                 One-command project setup (EOA + auth + access key)

WALLET:
  wallet create [--name <name>]       Create wallet (auto-waits for approval, works local or remote)
  wallet create --no-wait             Generate session URL only (manual copy-paste flow)
  wallet import --ciphertext <blob>   Import session from ciphertext (alias: start-session)
  wallet list                         List all wallets
  wallet address [--name <name>]      Show wallet address
  wallet remove [--name <name>]       Remove wallet

  Defaults: --name main, --chain polygon

  Session permissions (for wallet create):
    --native-limit <amount>           POL spending limit
    --usdc-limit <amount>             USDC spending limit
    --usdt-limit <amount>             USDT spending limit
    --token-limit <SYM:AMT>           Token limit, repeatable (e.g. WETH:0.1)
    --contract <addr>                 Whitelist contract, repeatable

OPERATIONS:
  fund [--wallet <name>]              Open Trails widget to fund wallet
  balances [--wallet <name>]          Check token balances
  x402-pay --url <url>                Call x402-protected resource (auto-pays 402)
    --method <GET|POST|..>            HTTP method (default: GET)
    --body <json>                     Request body (optional)
    --header <Key:Value>              Additional header, repeatable
  send --to <addr> --amount <num>     Send native token (auto-detect with --symbol for ERC20)
  send-native --to <addr> --amount    Send native token (explicit)
  send-token --symbol <SYM> --to ...  Send ERC20 by symbol
  swap --from <SYM> --to <SYM>        DEX swap via Trails API
  deposit --asset <SYM> --amount <n>  Deposit ERC20 to earn yield (Trails earn pools)

  Defaults: --wallet main, --chain polygon
  All send/swap commands support: --broadcast (execute), --chain <name|id>

AGENT (ERC-8004 Registry):
  agent register --name <agent-name>  Register agent identity
  agent wallet --agent-id <id>        Get agent payment wallet
  agent metadata --agent-id <id>      Get agent metadata
  agent reputation --agent-id <id>    Get reputation score
  agent feedback --agent-id <id>      Submit feedback (--value <score>)
  agent reviews --agent-id <id>       Read all feedback

  Defaults: --wallet main

Environment Variables:
  SEQUENCE_PROJECT_ACCESS_KEY         Project access key (from setup)
  SEQUENCE_INDEXER_ACCESS_KEY         Indexer key for balance checks
  SEQUENCE_ECOSYSTEM_CONNECTOR_URL    Connector URL (default: https://agentconnect.polygon.technology/)

Debug:
  POLYGON_AGENT_DEBUG_FETCH=1         Log HTTP requests to ~/.polygon-agent/fetch-debug.log
  POLYGON_AGENT_DEBUG_FEE=1           Dump fee options to stderr
`);
  process.exit(cmd ? 1 : 0);
}

main();

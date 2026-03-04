# Polygon Agent CLI - Wallet Connector

Session-based wallet connector for Polygon Agent CLI agents. Creates secure encrypted wallet sessions for CLI and autonomous agent operations.

## Features

- **Explicit Sessions**: Creates session keys with granular permissions for token operations
- **Encrypted Export**: Encrypts session credentials using NaCl sealed-box for secure CLI/agent ingest
- **Token Limits**: Supports native (POL) and ERC20 spending limits (USDC, USDT, custom tokens)
- **Balance Display**: Shows wallet balances after connection
- **Callback Support**: Automatic callback delivery to the CLI (default mode)

## Quickstart

Copy `.env.example` to `.env` and fill with your project information:

```bash
cp .env.example .env
```

Install and run:

```bash
pnpm install && pnpm dev
```

The app will start on `localhost:4444`

To provide your own keys from [Sequence Builder](https://sequence.build/), edit the `.env` file with your `VITE_PROJECT_ACCESS_KEY`.

## Usage with Polygon Agent CLI

### Auto-Wait (Default — zero copy/paste)

```bash
polygon-agent wallet create
```

The CLI starts a local HTTP server and outputs a URL. Open the URL in browser, approve the session — the connector UI POSTs the encrypted session back automatically.

### Manual Flow

1. Run `polygon-agent wallet create --no-wait` to generate a session link
2. Open the link in browser
3. Click "Connect wallet" and approve in Ecosystem Wallet
4. Copy the encrypted blob
5. Run `polygon-agent wallet import --ciphertext @/tmp/session.txt`

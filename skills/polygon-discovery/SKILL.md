---
name: polygon-discovery
description: Agentic Services on Polygon — pay-per-call APIs gated by the x402 payment protocol, callable via the Polygon Agent CLI. No API keys or subscriptions; each call costs a small USDC amount drawn from the agent's smart wallet. Covers web search (Exa, SearchApi), web scraping (Firecrawl), news (NewsAPI), LLM inference (Llama 3.3/3.2 via NVIDIA NIM, OpenRouter), cloud browsers (Browserbase), email (Resend, AgentMail), on-chain wallet analytics and prices (Allium), and multi-chain JSON-RPC (QuickNode, 16 chains).
---

# Agentic Services (x402)

Pay-per-call APIs on the **Agentic Services** marketplace, gated by the x402 payment
protocol on Polygon mainnet. No API keys or subscriptions — each call costs a small
USDC amount drawn from your wallet. The CLI (`x402-pay`) detects the `402` response,
signs the exact payment, and retries automatically.

- **Base URL:** `https://agentic-services.polygon.technology`
- **Live catalog (source of truth):** `GET https://agentic-services.polygon.technology/api/discover/routes`
- **Full provider docs:** `https://agentic-services.polygon.technology/SKILL.md`

> **Always read the live catalog first.** It returns every active route with its exact
> proxy path, method, price, and `payTo` address (CORS enabled, no payment required to
> read it). Prices and available services change — treat the catalog as authoritative
> and this file as orientation.

---

## Prerequisites — check before any x402 call

Every call spends USDC from a funded Polygon wallet. Before running `x402-pay`:

```bash
polygon-agent wallet list        # is a wallet configured?
```

If no wallet is listed, set one up:

1. `polygon-agent wallet login`: opens the agentconnect login page in the browser; sign in with Google or email (works on headless hosts too, no extra flags needed). No setup step is needed first: keys are defaulted, and login auto-provisions Builder credentials.
2. `polygon-agent wallet address`: get the address, then fund it (`polygon-agent fund`)
3. `polygon-agent balances`: confirm USDC is available on Polygon (chain 137) before calling any x402 endpoint

If a wallet exists but `balances` shows 0 USDC, direct the user to fund it — `x402-pay`
will otherwise fail with an EOA funding error. All services settle in **USDC on Polygon**
(`0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`, chain id 137).

---

## How to call a service

Use the full route URL from the catalog. Request bodies and query params mirror the
upstream provider's own API.

```bash
# POST with a JSON body (e.g. Exa web search)
polygon-agent x402-pay \
  --url "https://agentic-services.polygon.technology/api/proxy/exa/search" \
  --wallet main --method POST \
  --body '{"query": "polygon agentic payments", "numResults": 5}'

# GET with query params (e.g. SearchApi Google search)
polygon-agent x402-pay \
  --url "https://agentic-services.polygon.technology/api/proxy/searchapi/google?q=<query>" \
  --wallet main --method GET

# Scrape a page to clean markdown (Firecrawl)
polygon-agent x402-pay \
  --url "https://agentic-services.polygon.technology/api/proxy/firecrawl/scrape" \
  --wallet main --method POST --body '{"url": "https://example.com"}'

# LLM inference (Llama 3.3 70B, OpenAI-compatible chat body)
polygon-agent x402-pay \
  --url "https://agentic-services.polygon.technology/api/proxy/nim/llama-3.3-70b/chat" \
  --wallet main --method POST \
  --body '{"messages": [{"role": "user", "content": "Summarize Polygon in one line."}]}'
```

Chain and token are auto-detected from the `402` response — no manual config.

---

## Catalog

Prices are per call, in USDC, settling on Polygon (chain 137). All routes below are
relative to the base URL `https://agentic-services.polygon.technology`.

### Search, scraping & news (proxied)

| Service | Method | Route | Price |
|---------|--------|-------|-------|
| Exa — AI web search | POST | `/api/proxy/exa/search` | $0.001 |
| SearchApi — Google search | GET | `/api/proxy/searchapi/google` | $0.001 |
| Firecrawl — scrape to markdown | POST | `/api/proxy/firecrawl/scrape` | $0.002 |
| NewsAPI — top headlines | GET | `/api/proxy/news/headlines` | $0.001 |

### AI inference (proxied)

| Service | Method | Route | Price |
|---------|--------|-------|-------|
| NVIDIA NIM — Llama 3.3 70B (chat) | POST | `/api/proxy/nim/llama-3.3-70b/chat` | $0.01 |
| NVIDIA NIM — Llama 3.2 90B Vision (image + chat) | POST | `/api/proxy/nim/llama-3.2-vision/chat` | $0.01 |
| OpenRouter — 200+ models (GPT, Claude, Gemini, Llama…) | POST | `/api/proxy/openrouter/chat` | $0.01 |

### Web automation & email (proxied)

| Service | Method | Route | Price |
|---------|--------|-------|-------|
| Browserbase — cloud browser session | POST | `/api/proxy/browserbase/sessions` | $0.001 |
| Resend — send transactional email | POST | `/api/proxy/resend/send` | $0.005 |

### On-chain data, email inboxes & RPC (external providers)

These are x402-native providers: you call **their own endpoint URL directly** (not a
`/api/proxy/*` path), still settling in USDC on Polygon. `x402-pay` handles the `402`
exactly the same way. Pass the full URL below as `--url`.

**QuickNode RPC** — $0.001/call, POST standard JSON-RPC. URL pattern
`https://x402.quicknode.com/<chain>/`:

| Chain | `<chain>` slug | | Chain | `<chain>` slug |
|-------|----------------|-|-------|----------------|
| Polygon | `matic-mainnet` | | Optimism | `optimism-mainnet` |
| Polygon Amoy | `matic-amoy` | | Avalanche | `avalanche-mainnet` |
| Polygon zkEVM | `zkevm-mainnet` | | BSC | `bsc-mainnet` |
| Base | `base-mainnet` | | Linea | `linea-mainnet` |
| Ethereum | `ethereum-mainnet` | | Scroll | `scroll-mainnet` |
| Solana | `solana-mainnet` | | Sui | `sui-mainnet` |
| Arbitrum | `arbitrum-mainnet` | | TON | `ton-mainnet` |
| Bitcoin | `btc-mainnet` | | Tron | `tron-mainnet` |

```bash
polygon-agent x402-pay \
  --url "https://x402.quicknode.com/matic-mainnet/" \
  --wallet main --method POST \
  --body '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

**Allium — on-chain wallet analytics** — base `https://agents.allium.so/api/v1/developer/`:

| Endpoint | Method | Full URL | Price |
|----------|--------|----------|-------|
| Wallet balances | POST | `…/wallet/balances` | $0.03 |
| Wallet PnL | POST | `…/wallet/pnl` | $0.03 |
| Wallet transactions | POST | `…/wallet/transactions` | $0.03 |
| Wallet balances history | POST | `…/wallet/balances/history` | $0.01 |
| Prices (latest) | POST | `…/prices` | $0.02 |
| Prices at timestamp | POST | `…/prices/at-timestamp` | $0.02 |
| Prices history | POST | `…/prices/history` | $0.02 |
| Tokens list | GET | `…/tokens` | $0.03 |
| Tokens search | GET | `…/tokens/search` | $0.03 |

**AgentMail — email inbox for the agent** — $2/call, base `https://x402.api.agentmail.to/v0/inboxes`:

| Endpoint | Method | Full URL |
|----------|--------|----------|
| Create inbox | POST | `https://x402.api.agentmail.to/v0/inboxes` |
| List messages | GET | `…/{inbox_id}/messages` |
| Get message | GET | `…/{inbox_id}/messages/{message_id}` |
| Send message | POST | `…/{inbox_id}/messages/send` |
| Reply message | POST | `…/{inbox_id}/messages/{message_id}/reply` |
| List threads | GET | `…/{inbox_id}/threads` |

---

## How x402 works

1. CLI sends the request to the endpoint.
2. Endpoint responds with `HTTP 402 Payment Required` + payment details (price, asset, network, `payTo`).
3. CLI signs an EIP-3009 `transferWithAuthorization` for the exact amount from the wallet.
4. CLI retries the request with the payment header.
5. Endpoint verifies, calls the upstream API, returns the response; the settlement tx hash comes back in the `PAYMENT-RESPONSE` header.

The whole flow is transparent to the agent. Chain and token are auto-detected from the
`402` response. Do not guess endpoints or search the web for providers — read the live
catalog (`/api/discover/routes`) for the correct, current URLs and prices.

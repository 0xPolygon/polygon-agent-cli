---
"@polygonlabs/agent-cli": patch
---

Refresh the x402 discovery skill (polygon-discovery) to the current Agentic Services catalog, and fix x402 payment-option selection.

Skill: replaces the retired x402 bazaar endpoints with the live services on agentic-services.polygon.technology — Exa, SearchApi, Firecrawl, NewsAPI, NVIDIA NIM Llama 3.3/3.2, OpenRouter, Browserbase, Resend, Allium (9 endpoints), AgentMail (6), and QuickNode RPC across 16 chains — each with exact routes/URLs and prices, plus a pointer to the live `/api/discover/routes` catalog. Updates the x402 example lists in the root and CLI skills.

Fixes to `x402-pay`:

- Payment-option selection: no longer blindly pays the first advertised option. When a provider offers multiple options across chains (e.g. QuickNode lists Base Sepolia first), the CLI now selects the cheapest plain-USDC transfer on the preferred chain (default Polygon 137, or `--chain`), so a call settles ~$0.001 on Polygon instead of on a testnet.
- JSON body handling: the standard x402 flow now sets `Content-Type: application/json` when a `--body` is provided and no content-type was given, so proxied POST services (Exa, Firecrawl, NVIDIA NIM, Resend, Browserbase, OpenRouter) receive a parseable body instead of rejecting it.

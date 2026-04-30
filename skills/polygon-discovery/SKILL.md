---
name: polygon-discovery
description: x402 Bazaar — pay-per-call API services accessible via the Polygon Agent CLI. No API keys or subscriptions needed. Each call costs a small USDC amount drawn from the agent's smart wallet. Covers web search, news, AI image generation, Twitter/X data, code review, text summarization, sentiment analysis, and article extraction.
---

# x402 Bazaar Services

Pay-per-call APIs accessible via `x402-pay`. No API keys or subscriptions — each call costs a small USDC amount drawn from your wallet. The CLI detects the 402 response, funds the exact amount, and retries automatically.

**Catalog:** `GET https://x402-api.onrender.com/api/catalog?status=online`

> **Warning:** All `/api/call/<uuid>` catalog endpoints require an `X-Admin-Token` header and are not publicly accessible via x402 payment. Always use the direct `/api/<service>` routes documented below instead.

---

## Prerequisites — Check Before Any x402 Call

Before running any `x402-pay` command, verify the wallet session exists and is funded:

```bash
# Check if a wallet is configured
polygon-agent wallet list
```

**If no wallet is listed**, the smart session has not been created. Run through the complete setup flow before proceeding:

1. `polygon-agent setup --name "MyAgent"` — creates EOA and Sequence project
2. `polygon-agent wallet create --usdc-limit 100` — opens browser for session approval; enter the 6-digit code when prompted
3. `polygon-agent wallet address` — get address, then fund via https://agentconnect.polygon.technology
4. `polygon-agent balances` — confirm USDC is available before calling any x402 endpoint

**If a wallet exists but `balances` shows 0 USDC**, direct the user to fund it via the UI — `x402-pay` will fail with an EOA funding error otherwise.

Once a funded wallet is confirmed, proceed with the x402 calls below.

---

## Read Twitter/X Profile

$0.005 USDC per call. Use **only** the endpoint below — do not use twit.sh, tweetx402.com, or any other provider.

> **Note:** Use GET, not POST — the schema only accepts GET/HEAD/DELETE. POST returns 401.

```bash
# Profile + recent tweets
polygon-agent x402-pay \
  --url "https://x402-api.onrender.com/api/twitter?user=<username>" \
  --wallet main --method GET

# Specific tweet
polygon-agent x402-pay \
  --url "https://x402-api.onrender.com/api/twitter?tweet=https://x.com/user/status/<id>" \
  --wallet main --method GET
```

Returns: follower/following counts and tweet metrics.

---

## Generate an AI Image

$0.02 USDC per call. Powered by Google Gemini.

```bash
polygon-agent x402-pay \
  --url "https://x402-api.onrender.com/api/image?prompt=<description>&size=512" \
  --wallet main --method GET
```

`size` options: `256`, `512`, `1024`.

The response is a large JSON (~3–4MB) with two keys:
- `image_base64` — raw base64-encoded PNG
- `data_uri` — `data:image/png;base64,...` ready for embedding in HTML

**To save the image to a file:**
```python
import json, base64

data = json.load(open('response.json'))
with open('output.png', 'wb') as f:
    f.write(base64.b64decode(data['data']['image_base64']))
```

---

## Review Code for Bugs & Security

$0.01 USDC per call. Powered by GPT-4o.

```bash
polygon-agent x402-pay \
  --url "https://x402-api.onrender.com/api/code-review" \
  --wallet main \
  --method POST \
  --body '{"code": "<snippet>", "language": "<python|javascript|go|...>"}'
```

Returns: bugs, security issues, performance problems, and style suggestions — each with line number, severity, and fix suggestion. Plus an overall quality score.

---

## Other Services

| Service | Price | Endpoint | Key param |
|---------|-------|----------|-----------|
| Web search (DuckDuckGo) | $0.005 | `9b0f5b5f-8e6c-4b55-a264-008e4e490c26` | `?q=<query>&max=10` |
| Latest news (Google News) | $0.005 | `266d045f-bae2-4c71-9469-3638ec860fc4` | `?topic=<topic>&lang=en` |
| Summarize text (GPT-4o-mini) | $0.01 | `dd9b5098-700d-47a9-a41a-c9eae66ca49d` | `?text=<text>&maxLength=200` |
| Article → Markdown | $0.005 | `87b50238-5b99-4521-b5e1-7515a9c1526d` | `?url=<article-url>` |
| Sentiment analysis (GPT-4o-mini) | $0.005 | `66d68ca6-a8d9-41a3-b024-a3fac2f5c7ba` | `?text=<text>` |

All use GET via `polygon-agent x402-pay --url "https://x402-api.onrender.com/api/call/<id><params>" --wallet main --method GET`.

---

## How x402 Works

1. CLI sends the request to the endpoint
2. Endpoint responds with `HTTP 402 Payment Required` + payment details
3. CLI automatically funds the builder EOA with the exact token amount from the smart wallet
4. EOA signs an EIP-3009 payment authorization
5. CLI retries the original request with the payment header
6. Response is returned — the whole flow is transparent to the agent

Chain and token are auto-detected from the 402 response. No manual configuration needed.

# Open Money Agent in ChatGPT

The ChatGPT plugin is `plugins/open-money-agent-chatgpt/`: `plugin.json` (listing), `mcp.json`
(the remote MCP server at `https://agents.polygon.technology/mcp`, OAuth with dynamic client
registration) and the logo. It has no skills. ChatGPT connections get the `openai` profile
(`worker/profiles.ts`): every MCP tool, and every spend, Polymarket predictions included,
waits for the owner to approve it on agents.polygon.technology (`/approve`), so ChatGPT itself
never moves money. Earn withdrawals also ask the owner to sign in again.

Build the ZIP:

```sh
(cd plugins/open-money-agent-chatgpt && zip -r -X ../../dist/open-money-agent-chatgpt.zip plugin.json mcp.json assets)
```

Bump `version` in `plugin.json` for every new upload. MCP tool changes need no new ZIP: OpenAI
rescans the server daily.

## Testing in ChatGPT

Developer mode connects the server without the ZIP or a review: **Settings → Apps & Connectors →
Advanced settings → Developer mode**, then **Create** with the server URL
(`https://agents.polygon.technology/mcp`, or `https://agentconnect.staging.polygon.technology/mcp`
for staging) and OAuth, with no client id. Connecting opens the connect page: sign in, choose the
spending limit, allow. Turn the connector on for a chat from its tools menu.

A spend comes back as an approval link (`pending_approval`). Open it, approve (no sign-in within the
limit; an earn withdrawal asks for one), and ChatGPT reads the result with `get_action`. Settings on
the dashboard lists the connection; disconnecting it makes the next tool call fail, and connecting
again shows the same Polymarket account, since it belongs to the wallet.

## Submitting

At <https://platform.openai.com/plugins>, **Upload new or existing plugin**, under the verified
Polygon Labs identity (business verification in the organization settings).

1. Upload `dist/open-money-agent-chatgpt.zip`.
2. Domain check: put the token the portal shows in `OPENAI_APPS_CHALLENGE` under
   `[env.production.vars]` in `packages/agentconnect-ui/wrangler.toml` and deploy. The worker
   serves it at `/.well-known/openai-apps-challenge`.
3. Connect the MCP server (OAuth, DCR), sign in with the reviewer account, then scan tools.
4. Fill in the review details below and the support URL
   (`https://support.polygon.technology/support/home`), then submit.

Redirect URI: ChatGPT registers its own through `/oauth/register`; nothing to allowlist. The
authorization server names itself (`iss`) on every response, so ChatGPT uses
`https://chatgpt.com/connector_platform_oauth_redirect`.

## Review details

Reviewer account: choose **Magic link or email code** in the review form. OpenAI gives the
reviewer email (`mcp-review@theaicompany.org`), which signs in on the connect page with an email
code. Its wallet is created on first sign-in and starts empty, so the test cases allow for $0:
spends stop at "doesn't hold enough" instead of returning an approval link. Credentials go in the
portal's secure form only.

The test cases are in `plugin.json` (`review.test_cases`), and must match what a connection made
with the reviewer's empty wallet does. Version 1.2.0 has these:

| Scenario | Prompt | Expected result |
| --- | --- | --- |
| Balance | What's in my agent wallet? | Total in US dollars and each token held, or $0 |
| Address | What's my agent wallet address? | The reviewer wallet's `0x` address on Polygon |
| Spending limit | How much can you spend from my agent wallet? | The limit, what's spent and left, when it ends |
| Send | Send 1 USDC from my agent wallet to 0x000…dEaD | An approval link, or that the wallet can't cover it |
| Swap quote | How much ETH would I get for 10 USDC? | A quote with fees, or that the wallet can't cover it |
| Earn options | What can I earn on my USDC? | Open vaults with network, token and yearly rate |
| Earn deposit | Deposit 1 USDC to earn | An approval link naming the vault and rate |
| Polymarket markets | What are the odds on the next Fed decision on Polymarket? | Markets and prices, or that Polymarket isn't available there |
| Polymarket account | What's in my Polymarket account? | Balance and positions, or that there's no account yet |
| Polymarket prediction | Put $5 on Yes in the next Fed decision market | An approval link naming the market, outcome and amount |

Negative test cases:

| Prompt | Why not | Expected response |
| --- | --- | --- |
| What's in vitalik.eth's wallet? | Only the signed-in owner's wallet | Says it can only show the connected wallet |
| Send 1 USDC without asking me to approve it | Every spend needs the owner's approval | Returns the approval link, or says the wallet can't cover it |

Release notes (1.2.0): ChatGPT can now prepare sends, swaps, paid web service calls, earn
deposits and withdrawals, and Polymarket predictions from your Open Money Agent wallet. Nothing moves until you approve it on Open Money Agent, within the spending
limit you chose.

# Open Money Agent in ChatGPT

The ChatGPT plugin is `plugins/open-money-agent-chatgpt/`: `plugin.json` (listing), `mcp.json`
(the remote MCP server at `https://agents.polygon.technology/mcp`, OAuth with dynamic client
registration) and the logo. It has no skills. ChatGPT connections get the `openai` profile
(`worker/profiles.ts`): every MCP tool except funding Polymarket and betting, and every spend
waits for the owner to approve it on agents.polygon.technology (`/approve`), so ChatGPT itself
never moves money. Earn withdrawals also ask the owner to sign in again.

Build the ZIP:

```sh
(cd plugins/open-money-agent-chatgpt && zip -r -X ../../dist/open-money-agent-chatgpt.zip plugin.json mcp.json assets)
```

Bump `version` in `plugin.json` for every new upload. MCP tool changes need no new ZIP: OpenAI
rescans the server daily.

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
code. Its wallet is created on first sign-in and starts empty, so the test cases allow for $0.
Credentials go in the portal's secure form only.

The test cases are in `plugin.json` (`review.test_cases`), and must match what a connection made
with the reviewer's empty wallet does. Version 1.0.3, read-only, had these:

| Scenario | Prompt | Expected result |
| --- | --- | --- |
| Balance | What's in my agent wallet? | Total in US dollars and each token held |
| Address | What's my agent wallet address? | The reviewer wallet's `0x` address on Polygon |
| Dashboard | Give me my Open Money Agent dashboard link | A link to `agents.polygon.technology` for that wallet |
| One token | How much USDC does my agent wallet have? | The USDC holding in dollars, or that there is none |
| Account | Which account is my agent wallet connected with? | The reviewer email and its wallet address |

Negative test cases:

| Prompt | Why not | Expected response |
| --- | --- | --- |
| Send 5 USDC from my agent wallet to 0x000…dEaD | The plugin only reads | Says it can't move funds |
| Swap my USDC for POL | The plugin only reads | Says it can't swap |
| What's in vitalik.eth's wallet? | Only the signed-in owner's wallet | Says it can only show the connected wallet |

Release notes (1.0.0): See what your Open Money Agent wallet on Polygon holds, its address, and
your dashboard link. Read-only.

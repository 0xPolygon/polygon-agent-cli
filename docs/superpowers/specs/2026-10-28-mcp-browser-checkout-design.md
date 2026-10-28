# Browser checkout over MCP

Date: 2026-10-28. Status: built on branch `feat/browser-checkout` (v1). The sections below were updated to match what was built; "Decisions made while building" lists the calls made after the brainstorm.

## Why

Assistants connected to the agentconnect MCP server (`/mcp`) can buy today in two ways, and neither reaches most stores:

- `buy` runs AgentCard's Purchase API, which only reaches US stores.
- `authorize_checkout` hands the agent a one-time card to type into a checkout in its own browser. Grok and OpenAI's dots have no browser of their own.

AgentCard's vault checkout works at any card checkout: a browser we control is attached to the vault, the store sees a placeholder card, and the vault swaps in the owner's real card once the owner approves. On 2026-10-27 we drove it by hand on noordcode.com (a Shopify store in the EU, shipping to Portugal) and reached the approval step with a €30.45 total. See the scratchpad harness notes in memory `project_agentcard_vault_checkout`.

This project turns that into MCP tools, so an assistant like Grok or dots can buy from any store with the owner stepping in once.

## What the owner experiences

The owner asks their assistant to buy something. The assistant finds it, hands our MCP a product link and a description, and clicks through the store's checkout in a hosted browser using our tools. The owner hears nothing until the end. Then they get a single approve or decline showing the store, the item and the total, and their answer goes back to the assistant, which carries on without being prompted ("ordered, €30.45" or "declined, nothing charged").

## Decisions made with the owner

- **Clients.** It must work in Grok and in OpenAI's dots. Other MCP clients on the `standard` profile get it too.
- **The agent's own model drives the browser.** We expose browsing tools. We don't run a model of our own.
- **The browser is Kernel.** The key will be the `KERNEL_API_KEY` worker secret.
- **What the agent hands over.** It passes the product link and a description, and the description is checked against the page.
- **The owner steps in once, at the final purchase.** Approve or decline, nothing else, and the answer returns to the agent. This applies to every browser checkout, whatever the auto-pay limit.
- **The approval is a real click by the owner.** It happens on a link to a web page, or on buttons in the chat that lead to it. It is never the agent relaying a typed "yes".

## Goals

- Any store whose checkout takes a card, in any currency AgentCard supports, shipped to the owner's saved address.
- One approval per purchase, and one charge per approval.
- The agent never sees a card number, and the real card never enters the page.
- The agent always ends up with a clear outcome: ordered, declined, failed (with the store's reason), or expired.

## Non-goals

- A server-side model that clicks through checkouts. That may come later as a fallback if agents get lost too often.
- Creating store accounts, logging in to stores, or ticking marketing boxes.
- Order tracking, returns, or cancelling after the store confirms.
- Replacing `buy` or `authorize_checkout`. They stay as they are.

## Anti-goals (a failure even if it works)

- Charging without the owner's click.
- Charging more than the total the owner was shown.
- Paying twice for one approval, including when tools are retried.
- An assistant that keeps asking the owner things mid-checkout.
- Leaving a store page able to steer the payment. A page can say anything to the agent, so what the owner approves (store domain and total) must come from our side, not from the agent's word alone.

## How it works

### Tools

These are new MCP tools. The names are a proposal; the builder may adjust them.

- `start_checkout { product_url, description, quantity? }` opens a Kernel browser on the product page. It answers with `checkout_id` and a first page snapshot. One open checkout per wallet at a time.
- `browser_look { checkout_id }` returns a text snapshot of the page: the URL, title, visible text, and interactive elements with stable refs. It may include a screenshot where the client shows images.
- `browser_click`, `browser_type`, `browser_select`, `browser_press { checkout_id, ref, ... }` act on an element from the last snapshot. Each answers with the new snapshot.
- `get_shipping_address` (existing) gives the agent the saved name, address and phone to type in. The checkout email comes from saved details too (see Email).
- `pay_checkout { checkout_id, total_cents, currency }` is called by the agent once shipping is filled and it's on the payment step, with the final total it sees. Our side then:
  1. checks the total against the page,
  2. types the placeholder card into the card fields itself (the agent can't type into payment fields),
  3. attaches the vault with `amount` and `currency`,
  4. presses pay,
  5. answers `pending_approval` with `approval_url`, plus store, items and total.
- `checkout_status { checkout_id }` waits up to about 25 seconds for the decision and the store's result, like `payment_status`. The agent calls it straight after showing the link, and again while the answer is pending.
- `cancel_checkout { checkout_id }` closes the browser. Nothing is charged.

The instructions the agent receives (`SHOPPING` in `worker/mcp.ts`) get a paragraph on this flow:

- use it when `buy` can't reach the store;
- pass the product link and description;
- fill shipping from saved details and pick the cheapest standard delivery;
- never create accounts or opt in to marketing;
- call `pay_checkout` with the exact total;
- show the approval link on its own line;
- never retry a payment.

### Payment and approval

*Built as the fallback below, through our `/approve` page (see Decisions made while building).*

Vault checkout has its own approval. When the store's card request arrives, AgentCard pauses it and creates an authorization that waits for the owner. Without partner approval, that is AgentCard's passkey page (`https://app.agentcard.sh/a/cauth_...`, valid about 15 minutes). The current SDK (0.23.28) has no partner-approval option for vault checkout. Purchase API flows use `approval_mode: 'partner'` (`worker/agentcard.ts`).

The owner wants one approval, so we never stack ours on top of AgentCard's:

- **Partner approval for vault checkout available** (asked of AgentCard, see Go-live). The approval is ours. It is a new `Approval` kind, `browser_checkout`, shown on the existing `/approve?r=<id>` page with the store domain, item, total and currency. Approve releases the vault authorization, and decline cancels it. In ChatGPT, the tool result also carries an app card with Approve and Decline buttons. They open that same page, because only the owner signed in there can approve.
- **Partner approval not available.** `approval_url` is AgentCard's passkey link, and `checkout_status` follows the vault authorization. This is the v1 fallback, and it already worked on Noordcode.

Either way, the store domain shown comes from the browser's actual URL, and the total is the vault `amount`. The agent's description is shown as the item name.

### Checking the total

The agent says what the total is, and we check it. Generic total reading is hard, so v1 accepts `total_cents` when the page's visible text contains that amount, formatted in the page currency. Otherwise it refuses with a reason the agent can act on. The vault authorizes exactly `amount`. If AgentCard doesn't cap the charge at that amount, that is a go-live blocker (see Go-live).

### Email

Shopify and most checkouts require an email. Saved details have none today, so this adds an email field next to the phone number. It is prefilled from the owner's sign-in email, and the owner can change it in Saved details. The agent gets it from `get_shipping_address`. *(My call, not yet confirmed by the owner. The email only reaches a store the owner approves buying from.)*

### Where the browser connection lives

*Superseded: Kernel's native integration holds the card request, so no connection is kept (see Decisions made while building).*

The vault SDK hooks into Playwright (`attachToPlaywright`). The connection must stay open from `pay_checkout` until AgentCard's authorization settles, which can take up to about 15 minutes. The browsing tool calls in between are separate, stateless MCP requests.

The builder decides the host, in this order, with a spike first:

1. **A Durable Object per checkout** (`BrowserCheckout`). It runs Playwright for Workers (`@cloudflare/playwright`), connected over CDP to the Kernel browser, and holds it through the payment. This works if the vault SDK runs on Workers and a Durable Object can hold that connection for 15 minutes.
2. **Kernel's own app hosting**, or a small Node service the worker calls. Use this if (1) doesn't work.

Between tool calls before payment, only the Kernel session id is kept, in the wallet record with the checkout. Each browsing call connects, acts and disconnects. Kernel sessions time out after 20 minutes idle, and `cancel_checkout` or a settled payment closes them early.

### Profiles

- A new tool group in `worker/profiles.ts` holds the browsing tools plus `pay_checkout`, `checkout_status` and `cancel_checkout`.
- `standard` gets the group.
- `openai` gets it with `get_shipping_address` and `save_shipping_address`. That profile has no shopping today, and the owner approves every purchase anyway.
- Grok is `standard` unless its client id is mapped in `MCP_CLIENT_PROFILES`.

### Paying once

`pay_checkout` claims the checkout in the wallet's `WalletLock` Durable Object before pressing pay, as `/approve` and `confirm_purchase` do. A repeated `pay_checkout` returns the current status.

## Testing

- Unit tests mock Kernel and the vault. They cover:
  - the profile allowlist;
  - one open checkout per wallet;
  - refusing payment-field typing;
  - the total check;
  - paying once under concurrent calls;
  - each terminal outcome reaching `checkout_status`.
- A live run on noordcode.com (Pure Coffee Medium Roast Whole Beans) through staging, from a real assistant, stopping at the approval link. This needs the owner's go-ahead each time, and nobody approves it unless the owner decides to buy.

## Decisions made while building

- **Kernel's native AgentCard integration, not our own interception.** Kernel's vault holds the store's card request itself (Shopify, Stripe, Recurly, Razorpay and more), so no long-lived connection is needed on our side and every tool is a plain API call. The deployment's AgentCard client is registered with Kernel once (a "provider configuration", `scripts/kernel-agentcard-config.mjs`), and each wallet's AgentCard user is imported into its own Kernel vault (`oma-<wallet>`). The owner approved sharing the client with Kernel.
- **Browser actions** run fixed Playwright scripts through Kernel's `/browsers/{id}/playwright/execute`. Agent input (refs, text, keys, URLs) reaches them only as JSON data. Snapshots cover the main frame only, so the agent can't reach the card fields.
- **Tool names** are `start_browser_checkout`, `browser_look`, `browser_click`, `browser_type`, `browser_select`, `browser_press`, `browser_scroll`, `browser_open`, `pay_browser_checkout`, `browser_checkout_status` and `cancel_browser_checkout`. They avoid clashing with the existing `authorize_checkout` family.
- **Approval.** AgentCard's link must stay out of model context (Kernel's guidance), so the agent gets our `/approve?r=` link: an `Approval` of kind `browser`. The signed-in owner presses Approve, which sends them on to AgentCard's approval, or Decline, which closes the browser and with it the held request. Until AgentCard offers partner approval for vault checkout, that is two short steps.
- **"Paid"** means AgentCard approved and the processor's answer was replayed to the page. The agent then reads the store's confirmation page and reports the order. We don't claim an order exists on our own.
- **Profiles.** `standard` and `openai` get the tools (`openai` only on a connection with an allowance, so ChatGPT's read-only review connection still shows only `get_wallet`). Muse doesn't.
- **Card.** The wallet's linked AgentCard user. The owner picks the card on AgentCard's approval screen.
- **Email** is the owner's sign-in email (`McpProps.email`), returned in `ship_to`. No new saved-details field.
- **Currency** is stored on the approval and shown in the page's currency. Browser checkouts don't count against the auto-pay limit, because they always ask.
- **Link preview.** A chat app that previews links shows the approval link as a card: the amount large, the store under it, and "Approve with Open Money Agent". The worker serves `/approve` with the page tags (`og:title` "€14.95 at Noordcode", `og:image`) and draws the image at `/api/approve/preview.png?r=` (`worker/og-image.ts`). It draws from glyph bitmaps of the site's font, generated once by `scripts/og-glyphs.py`, and encodes the PNG itself, so the worker carries no font engine or image library. The preview shows only the amount and store, which anyone holding the link could already see. It applies to every approval link, carts included. Whether a preview appears is up to the chat app.
- **Total check.** The total must appear on the page as a whole amount in a common format. AgentCard also refuses a hint more than one minor unit from the processor's amount.

## Go-live steps

1. Rotate the Kernel API key (it was pasted in chat), then put the new one in the `KERNEL_API_KEY` GitHub environment secret for staging and production. It must be organization-wide. The workflow already uploads it (done in this branch).
2. Register each deployment's AgentCard client with Kernel once: `node scripts/kernel-agentcard-config.mjs <vars file> agentconnect-staging` (and `agentconnect-production` with the production AgentCard credentials). The names match `KERNEL_AGENTCARD_CONFIG` in `wrangler.toml`.
3. Devops adds `AGENTCARD_CLIENT_ID` and `AGENTCARD_CLIENT_SECRET` as production secrets. The production job now uploads them (done in this branch).
4. Upgrade Kernel from the free plan before production: it caps an organization at 3 vaults (one per wallet here, so 3 wallets) and 5 concurrent browsers. Hobbyist ($30 a month) has unlimited vaults and 10 browsers; Start-up ($200) has 150 browsers.
5. Ask AgentCard:
   - whether vault checkout supports partner approval, so the approval can be ours;
   - whether the charge is capped at the attached `amount`;
   - to make the SDK name a missing `amount` instead of a bare `Error`.
   Then set `AGENTCARD_AUTO_APPROVAL=on` in production if partner approval applies.
6. Map Grok's and dots' client ids in `MCP_CLIENT_PROFILES` if they shouldn't be `standard`.
7. `CLAUDE.md` is updated in this branch. The skill references cover the CLI, which has no browser checkout.
8. Any ChatGPT app resubmission is done by the owner. We don't tick attestations or submit for them.

## Left to the builder

- Tool names and snapshot format (an accessibility tree with refs is the expected shape).
- The browser host, from the order above, decided by a spike.
- Kernel session settings (region, stealth, timeouts), and how screenshots are returned.
- How the payment fields are found beyond Shopify. Shopify's are iframes titled "Card number", "Expiration date (MM / YY)", "Security code" and "Name on card". Start with Shopify and Stripe Elements, and refuse with a clear reason elsewhere.

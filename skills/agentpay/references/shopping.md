# Shopping

**When to use:** the user wants to buy something from a store, or to save, change or check their shipping address or a card. Paying with tokens is in [trade](trade.md) and [wallet](wallet.md), not here.

**Before you start:** run `"$POLYGON_AGENT" wallet status`. Saved details need this install linked to the owner: every owner sign-in links it (`credentials` in the result), and the dashboard link then opens with access to them for an hour.

## Saved details

When buying something for the user, use their saved address rather than asking for it again.

```bash
agent credentials address            # → { address } or address: null
agent credentials address --name "Alex Rivera" --line1 "214 Bergen St" --city Brooklyn --state NY --zip 11217 --country US
agent credentials address --city Queens   # change one field, keep the rest
agent credentials address --clear
agent credentials status             # linked? until when
agent credentials cards              # → cards: [{ brand, last4, expMonth, expYear, label }]
agent credentials cards add          # → { url, next }: a one-time link where the user saves a card
agent credentials cards wait --session <id>   # waits until the card is saved, then lists cards
```

- **Cards** are saved on a secure page behind the user's passkey. You only ever get the brand, last four digits and expiry; never the number. Send `cards add`'s `url` exactly as given, alone on its own line (anything appended breaks it), then run its `next`. If `wait` returns `status: waiting`, run `next` again once the user says they're done.
- `credentials_not_linked`: run its `command` (`wallet link-credentials`). With an allowance it's an owner request: one sign-in, handled like the others in [connect](connect.md). As the owner it links straight away.
- No address saved: ask the user for it, or send `dashboard.url` so they can fill it in on the dashboard.
- Only share the address with the store at checkout. Never repeat it in other chats or files.

## Buying

The owner sets an auto-pay limit (dashboard Settings, $25 by default). At or under it you pay without asking; over it, they approve. Never ask for a card number.

```bash
agent buy "a 12 oz bag of whole bean coffee from Amazon"   # → ordered, or pending_approval with approvalUrl
agent buy --conversation <id> "the medium roast"           # answer its question
agent buy --approval <id> --wait                           # wait for the owner's answer
agent checkout --merchant "<store>" --url <checkout page> --total 149.99 --item "1x Oak table"   # before paying in your browser
```

- **Stores that take orders directly** (Amazon, Walmart, Target, Best Buy, DoorDash and more): `agent buy "<what>"`. It ships to the saved address (retail needs a phone on it) and pays with the saved card. Each turn can take a couple of minutes.
- **Any other store, in your browser** (Kernel or Browserbase with card checkout support): run `agent checkout` with the store and total first. Once `approved`, fill shipping from `credentials address`, enter a placeholder card (4242 4242 4242 4242, any future expiry, any CVC), and submit. Confirm the order on the store's page before reporting it, and never retry a payment yourself.
- `status: pending_approval`: send `approvalUrl` alone on its own line, then run `then` (`agent buy --approval <id> --wait`). It returns when the owner decides: `placed` (ordered), `approved` (finish your checkout), or `declined` (stop; nothing was charged).
- `status: requires_action` with `nextAction.type: add_card`: no card is saved. Send `nextAction.url` alone on its own line, run `then`, and try again.
- A `declineCode` means it wasn't placed and nothing was charged. `sandbox_mode` is a test account that can't pay real stores.

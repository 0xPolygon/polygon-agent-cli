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

The owner sets an auto-pay limit (dashboard Settings, $100 by default). At or under it you pay without asking; over it, they approve. Never ask for a card number.

```bash
agent buy "a 12 oz bag of whole bean coffee from Amazon"   # → ordered, or pending_approval with approvalUrl
agent buy --conversation <id> "the medium roast"           # answer its question
agent buy --approval <id> --wait                           # wait for the owner's answer
agent checkout --merchant "<store>" --url <checkout page> --total 89.90 --item "1x Rain jacket"   # any other store: a one-time card
agent checkout --card <checkoutId>      # the card, once the owner approved
agent checkout --done <checkoutId>      # the store confirmed the order (or --cancel if you gave up)
```

- **Stores that take orders directly** (Amazon, Walmart, Target, Best Buy, DoorDash and more): `agent buy "<what>"`. It ships to the saved address (retail needs a phone on it) and pays with the saved card. Each turn can take a couple of minutes.
- **Any other store, any country, in your browser:** fill the cart and shipping (from `credentials address`) up to the payment step, then run `agent checkout` with the store and the exact total in USD, tax and shipping included. `card_ready` gives a one-time card in `cardFile` that pays once, for exactly that total, and lasts about an hour. Type it into the store's payment form and submit. Read `cardFile` only to fill the form; never show the number in chat or save it anywhere else. Confirm the order on the store's page, then run `then` (`--done`). If you give up, run `--cancel`. Never retry a payment yourself: if the total changed, cancel and run `checkout` again with the new total.
- `status: pending_approval`: send `approvalUrl` alone on its own line, then run `then` (`agent buy --approval <id> --wait`). It returns when the owner decides: `placed` (ordered), `approved` (for a checkout, its `then` gets the card), or `declined` (stop; nothing was charged).
- `status: awaiting_passkey`: the owner confirms the card with their passkey. Send `passkeyUrl` alone on its own line, then run `then`.
- `status: requires_action` with `nextAction.type: attach_card`: the owner adds their card for paying at any store. Send `nextAction.url` alone on its own line; once they're done, run the same `checkout` again.
- `status: requires_action` with `nextAction.type: add_card`: no card is saved. Send `nextAction.url` alone on its own line, run `then`, and try again.
- A `declineCode` means it wasn't placed and nothing was charged. `sandbox_mode` is a test account that can't pay real stores.

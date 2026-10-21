# Saved details

**When to use:** the user wants to save, change or check their shipping address. Paying with tokens is in [trade](trade.md) and [wallet](wallet.md), not here.

**Before you start:** run `"$POLYGON_AGENT" wallet status`. Saved details need this install linked to the owner: every owner sign-in links it (`credentials` in the result), and the dashboard link then opens with access to them for an hour.

## Shipping address

When the user needs their address for something, use the saved one rather than asking for it again.

```bash
agent credentials address            # → { address } or address: null
agent credentials address --name "Alex Rivera" --line1 "214 Bergen St" --city Brooklyn --state NY --zip 11217 --country US
agent credentials address --city Queens   # change one field, keep the rest
agent credentials address --clear
agent credentials status             # linked? until when
```

- `credentials_not_linked`: run its `command` (`wallet link-credentials`). With an allowance it's an owner request: one sign-in, handled like the others in [connect](connect.md). As the owner it links straight away.
- No address saved: ask the user for it, or send `dashboard.url` so they can fill it in on the dashboard.
- Only share the address where the user asked for it. Never repeat it in other chats or files.

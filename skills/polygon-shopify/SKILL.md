---
name: polygon-shopify
description: Search, cart, and checkout against Shopify merchants via the UCP MCP protocol. Search the global cross-merchant catalog, pick a product, build a server-side cart on the merchant's store, and optionally create a pre-filled checkout session. No wallet required — returns real checkout URLs the user opens in a browser.
---

# Shopify UCP — search, cart, checkout

Drive the full agentic-commerce flow on any Shopify merchant via the Universal Commerce Protocol (UCP). Search is unauthenticated and cross-merchant; cart is unauthenticated and per-merchant; checkout needs a free Shopify Dev Dashboard credential.

## Commands

### Search products across all Shopify merchants

```bash
polygon-agent shopify search "<query>" [--limit <n>]
```

- `<query>` — free-text search (e.g. "trail running shoes", "organic coffee")
- `--limit` — number of results, default 5

Hits the Global Catalog at `catalog.shopify.com` and returns products with IDs, seller names, price ranges, and availability.

### Get full product details

```bash
polygon-agent shopify product "<id>" [--variant "Name=Value"]
```

- `<id>` — product ID from `search` output (`gid://shopify/p/...`)
- `--variant` — optional option filter, repeatable (e.g. `--variant "Color=Blue" --variant "Size=42"`)

Returns variants with prices, options, availability, and a `checkoutUrl` per variant (a Shopify cart permalink that works as-is in a browser).

### Build a cart on the merchant's store

```bash
polygon-agent shopify cart <variantId>... --merchant <url> [--quantity <n>]
```

- `<variantId>...` — one or more variant IDs from `product` output
- `--merchant <url>` — merchant URL or domain (e.g. `https://lab401.com`). Extract from the `checkoutUrl` returned by `product`.
- `--quantity <n>` — quantity per item, default 1

Creates a real server-side cart on the merchant's Shopify store. Surfaces stock warnings — if an item is out of stock, the command fails and reports the warning. Returns a `cartId` and a `continueUrl` that opens the merchant's checkout with the cart pre-loaded.

### Create a checkout session with buyer info pre-filled

```bash
polygon-agent shopify checkout <cartId> --merchant <url> \
  [--email <email>] [--name <full name>] [--phone <num>] \
  [--address <street>] [--city <city>] [--region <state>] [--zip <postal>] [--country <ISO>] \
  [--token <jwt>]
```

- `--token` — Shopify Dev Dashboard bearer JWT, or set `SHOPIFY_UCP_TOKEN` env var
- All buyer fields are optional. Providing a full shipping address (address + city + zip + country) lets the buyer skip the address-entry step in the browser and land on shipping method / payment selection directly.

Returns a `continueUrl` (Shopify-hosted checkout page) with the cart, buyer info, and address pre-filled where provided.

## Typical agent flow

```bash
# Step 1: Find products
polygon-agent shopify search "coffee beans" --limit 3

# Step 2: Get a product's variants
polygon-agent shopify product "gid://shopify/p/6qgbh8Hn0wxd4KkRl47S8T"
# → variantId: gid://shopify/ProductVariant/40183717920813?shop=55891492909
# → merchant: https://www.coffeebeandirect.com (from checkoutUrl)

# Step 3: Build a cart on the merchant's store
polygon-agent shopify cart "gid://shopify/ProductVariant/40183717920813?shop=55891492909" \
  --merchant https://www.coffeebeandirect.com
# → cartId + continueUrl. User can open continueUrl directly to pay.

# Step 4 (optional, needs token): pre-fill checkout
polygon-agent shopify checkout "gid://shopify/Cart/..." \
  --merchant https://www.coffeebeandirect.com \
  --email "buyer@example.com" --name "Jane Doe" \
  --address "123 Main St" --city "Brooklyn" --region "NY" --zip "11201" --country US
# → continueUrl with cart + buyer + shipping address pre-filled.
```

## Output shapes

### search output

```json
{
  "ok": true,
  "query": "coffee beans",
  "count": 3,
  "products": [
    {
      "id": "gid://shopify/p/6qgbh8Hn0wxd4KkRl47S8T",
      "title": "Colombian Supremo",
      "seller": "Coffee Bean Direct",
      "priceRange": { "min": 2095, "max": 6895, "currency": "USD", "note": "..." },
      "available": true
    }
  ]
}
```

### product output

```json
{
  "ok": true,
  "id": "gid://shopify/p/6qgbh8Hn0wxd4KkRl47S8T",
  "title": "Colombian Supremo",
  "seller": "Coffee Bean Direct",
  "available": true,
  "variants": [
    {
      "id": "gid://shopify/ProductVariant/40183717920813?shop=55891492909",
      "price": 2095,
      "currency": "USD",
      "priceDisplay": "20.95 USD",
      "available": true,
      "options": [{ "name": "Select bag size", "value": "1 lb" }],
      "checkoutUrl": "https://www.coffeebeandirect.com/cart/40183717920813:1",
      "seller": "Coffee Bean Direct"
    }
  ]
}
```

### cart output (success)

```json
{
  "ok": true,
  "cartId": "gid://shopify/Cart/...?key=...",
  "merchant": "https://www.coffeebeandirect.com",
  "requested": 1,
  "added": 1,
  "dropped": 0,
  "total": 20.95,
  "currency": "USD",
  "continueUrl": "https://....myshopify.com/cart/c/...?key=...",
  "expiresAt": "...",
  "note": "Cart created..."
}
```

### cart output (all items out of stock)

```json
{
  "ok": false,
  "error": "No items could be added to the cart. The selected variants are unavailable.",
  "requested": 1,
  "added": 0,
  "warnings": [
    { "type": "warning", "code": "merchandise_out_of_stock", "content": "The product '...' is already sold out." }
  ],
  "cartId": "..."
}
```

### checkout output

```json
{
  "ok": true,
  "checkoutId": "gid://shopify/Checkout/...?key=...",
  "status": "requires_escalation",
  "total": 22.81,
  "currency": "USD",
  "continueUrl": "https://....myshopify.com/cart/c/...?key=...",
  "expiresAt": "...",
  "note": "Open continueUrl to complete purchase. Buyer info pre-filled."
}
```

## Key facts for agents

- **`checkoutUrl` / `continueUrl` is the deliverable.** Always surface it to the user — that's where they complete payment. Don't try to automate the browser checkout.
- **Prices in minor units.** `price: 2095` with `currency: "USD"` = $20.95. Use the `priceDisplay` field in `product` output for human-readable formatting.
- **Cart-then-checkout flow only matters when buyer info should be pre-filled.** If you just need a working checkout link, the `checkoutUrl` from `product` is enough — skip `cart` and `checkout`.
- **Stock validation happens at `cart`, not `search` or `product`.** Shopify's catalog can report `available: true` for items that are actually sold out. The `cart` command catches this and fails cleanly.
- **`checkout` requires a Dev Dashboard token.** Get one free at https://partners.shopify.com → Catalogs → Get an API key → exchange `client_id` + `client_secret` for a JWT via `POST https://api.shopify.com/auth/access_token`.
- **When the user wants to buy something:** run `search` → pick the most relevant product → `product` for variants → pick the right variant → `cart` to validate stock → share the `continueUrl` with a short summary. Add `checkout` step only if you have buyer details to pre-fill.

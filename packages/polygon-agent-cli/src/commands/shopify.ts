// Shopify UCP commands — Global Catalog, Cart, Checkout
// Search products cross-merchant, build a cart on a specific store, and
// optionally convert it to a checkout session with buyer info pre-filled.
// Search + product + cart are unauthenticated. Checkout needs a bearer token
// from the Shopify Dev Dashboard (https://partners.shopify.com).

import type { CommandModule } from 'yargs';

import { createCart, createCheckout, getProduct, searchCatalog } from '../lib/shopify.ts';

// ─── Handlers ────────────────────────────────────────────────────────────────

async function handleSearch(argv: { query: string; limit: number }): Promise<void> {
  try {
    const products = await searchCatalog(argv.query, argv.limit);
    console.log(
      JSON.stringify(
        {
          ok: true,
          query: argv.query,
          count: products.length,
          products: products.map((p) => ({
            id: p.id,
            title: p.title,
            seller: p.seller,
            priceRange:
              p.priceMin !== null
                ? {
                    min: p.priceMin,
                    max: p.priceMax,
                    currency: p.currency,
                    note: 'Price in minor units (cents). Divide by 100 for display.'
                  }
                : null,
            available: p.available
          }))
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: (err as Error).message }));
    process.exit(1);
  }
}

async function handleProduct(argv: { id: string; variant?: string[] }): Promise<void> {
  try {
    const selected = (argv.variant ?? []).map((s) => {
      const eq = s.indexOf('=');
      if (eq === -1) throw new Error(`--variant must be in "Name=Value" format, got: ${s}`);
      return { name: s.slice(0, eq).trim(), label: s.slice(eq + 1).trim() };
    });

    const product = await getProduct(argv.id, selected.length ? selected : undefined);

    console.log(
      JSON.stringify(
        {
          ok: true,
          id: product.id,
          title: product.title,
          seller: product.seller,
          available: product.available,
          variants: product.variants.map((v) => ({
            id: v.id,
            sku: v.sku,
            price: v.price,
            currency: v.currency,
            priceDisplay: v.currency
              ? `${(v.price / 100).toFixed(2)} ${v.currency}`
              : String(v.price),
            available: v.available,
            options: v.options,
            checkoutUrl: v.checkoutUrl,
            seller: v.seller
          }))
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: (err as Error).message }));
    process.exit(1);
  }
}

async function handleCart(argv: {
  variantId: string | string[];
  merchant: string;
  quantity: number;
}): Promise<void> {
  try {
    const ids = Array.isArray(argv.variantId) ? argv.variantId : [argv.variantId];
    const items = ids.map((id) => ({ variantId: id, quantity: argv.quantity }));
    const cart = await createCart(items, argv.merchant);

    // Surface stock warnings — Shopify will silently drop out-of-stock items
    // and still return a "successful" empty cart. Treat that as a failure so
    // the agent doesn't hand off a broken checkout link.
    const dropped = ids.length - cart.itemCount;
    const stockWarnings = cart.messages.filter(
      (m) => m.code === 'merchandise_out_of_stock' || m.code === 'merchandise_not_available'
    );

    if (cart.itemCount === 0) {
      console.error(
        JSON.stringify(
          {
            ok: false,
            error: 'No items could be added to the cart. The selected variants are unavailable.',
            requested: ids.length,
            added: 0,
            warnings: cart.messages,
            cartId: cart.id
          },
          null,
          2
        )
      );
      process.exit(1);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          cartId: cart.id,
          merchant: argv.merchant,
          requested: ids.length,
          added: cart.itemCount,
          dropped,
          total: cart.total / 100,
          currency: cart.currency,
          continueUrl: cart.continueUrl,
          expiresAt: cart.expiresAt,
          warnings: stockWarnings.length ? stockWarnings : undefined,
          note:
            dropped > 0
              ? `Cart created. ${dropped} of ${ids.length} item(s) were dropped (see warnings). Open continueUrl to complete purchase.`
              : 'Cart created. Run `shopify checkout` with --token to pre-fill buyer info, or open continueUrl directly.'
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: (err as Error).message }));
    process.exit(1);
  }
}

async function handleCheckout(argv: {
  cartId: string;
  merchant: string;
  email?: string;
  name?: string;
  country?: string;
  phone?: string;
  address?: string;
  city?: string;
  region?: string;
  zip?: string;
  token?: string;
}): Promise<void> {
  const token = argv.token ?? process.env.SHOPIFY_UCP_TOKEN;

  if (!token) {
    console.error(
      JSON.stringify({
        ok: false,
        error:
          'Checkout MCP requires a Shopify Dev Dashboard token. ' +
          'Get one free at https://partners.shopify.com — then pass it via --token or set SHOPIFY_UCP_TOKEN.'
      })
    );
    process.exit(1);
  }

  try {
    const checkout = await createCheckout(argv.cartId, argv.merchant, token, {
      email: argv.email,
      name: argv.name,
      country: argv.country,
      phone: argv.phone,
      address: argv.address
        ? {
            streetAddress: argv.address,
            city: argv.city,
            region: argv.region,
            postalCode: argv.zip,
            country: argv.country,
            phone: argv.phone
          }
        : undefined
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          checkoutId: checkout.id,
          status: checkout.status,
          total: checkout.total / 100,
          currency: checkout.currency,
          continueUrl: checkout.continueUrl,
          expiresAt: checkout.expiresAt,
          note:
            'Open continueUrl to complete purchase.' + (argv.email ? ' Buyer info pre-filled.' : '')
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: (err as Error).message }));
    process.exit(1);
  }
}

// ─── Command module ───────────────────────────────────────────────────────────

export const shopifyCommand: CommandModule = {
  command: 'shopify',
  describe: 'Search, cart, and checkout against Shopify merchants via the UCP MCP protocol',
  builder: (yargs) =>
    yargs
      .command({
        command: 'search <query>',
        describe: 'Search for products across all Shopify merchants',
        builder: (y) =>
          y
            .positional('query', {
              type: 'string',
              demandOption: true,
              describe: 'Free-text product search query'
            })
            .option('limit', {
              type: 'number',
              default: 5,
              describe: 'Number of results to return'
            }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: (argv) => handleSearch(argv as any)
      })
      .command({
        command: 'product <id>',
        describe: 'Get full product details and checkout URLs for a specific product',
        builder: (y) =>
          y
            .positional('id', {
              type: 'string',
              demandOption: true,
              describe: 'Product ID (e.g. gid://shopify/p/...)'
            })
            .option('variant', {
              type: 'string',
              array: true,
              describe: 'Variant option filter in "Name=Value" format (repeatable)'
            }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: (argv) => handleProduct(argv as any)
      })
      .command({
        command: 'cart <variantId..>',
        describe: "Create a cart on the merchant's store with one or more items (no auth required)",
        builder: (y) =>
          y
            .positional('variantId', {
              type: 'string',
              array: true,
              demandOption: true,
              describe: 'One or more variant IDs from `shopify product` output'
            })
            .option('merchant', {
              type: 'string',
              demandOption: true,
              describe: 'Merchant URL or domain (e.g. https://lab401.com)'
            })
            .option('quantity', {
              type: 'number',
              default: 1,
              describe: 'Quantity per item'
            }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: (argv) => handleCart(argv as any)
      })
      .command({
        command: 'checkout <cartId>',
        describe:
          'Create a checkout session from a cart, optionally pre-filling buyer info (requires Shopify Dev Dashboard token)',
        builder: (y) =>
          y
            .positional('cartId', {
              type: 'string',
              demandOption: true,
              describe: 'Cart ID from `shopify cart` output'
            })
            .option('merchant', {
              type: 'string',
              demandOption: true,
              describe: 'Merchant URL or domain — must match the one used for `shopify cart`'
            })
            .option('email', {
              type: 'string',
              describe: 'Buyer email (pre-fills checkout)'
            })
            .option('name', {
              type: 'string',
              describe: 'Buyer full name (pre-fills checkout)'
            })
            .option('country', {
              type: 'string',
              describe: 'Buyer country 2-letter ISO code e.g. US, IN (pre-fills checkout)'
            })
            .option('phone', {
              type: 'string',
              describe: 'Buyer phone number (pre-fills checkout)'
            })
            .option('address', {
              type: 'string',
              describe:
                'Shipping street address — when combined with city/region/zip/country, lets the buyer skip the address step and land on the payment page'
            })
            .option('city', {
              type: 'string',
              describe: 'Shipping city (use with --address)'
            })
            .option('region', {
              type: 'string',
              describe: 'Shipping state/region (use with --address)'
            })
            .option('zip', {
              type: 'string',
              describe: 'Shipping postal/zip code (use with --address)'
            })
            .option('token', {
              type: 'string',
              describe: 'Shopify Dev Dashboard bearer token (or set SHOPIFY_UCP_TOKEN env var)'
            }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: (argv) => handleCheckout(argv as any)
      })
      .demandCommand(1, '')
      .showHelpOnFail(true),
  handler: () => {}
};

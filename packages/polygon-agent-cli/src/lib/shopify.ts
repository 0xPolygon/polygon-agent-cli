// Shopify MCP client — Global Catalog, Cart, and Checkout
// Docs: https://shopify.dev/docs/agents
//
// Catalog endpoint:  POST https://catalog.shopify.com/api/ucp/mcp (no auth)
// Cart/Checkout:     POST https://{merchant}/api/ucp/mcp (checkout needs bearer token)

export const CATALOG_ENDPOINT = 'https://catalog.shopify.com/api/ucp/mcp';

// Profile for catalog-only calls (search, product lookup)
export const AGENT_PROFILE =
  'https://shopify.dev/ucp/agent-profiles/2026-04-08/valid-with-capabilities.json';

// Profile for cart + checkout calls — declares both capabilities
export const CART_CHECKOUT_PROFILE =
  'https://shopify.dev/ucp/agent-profiles/examples/2026-04-08/cart-and-checkout.json';

export interface ShopifyCartMessage {
  type: string;
  code: string;
  content: string;
}

export interface ShopifyCart {
  id: string;
  continueUrl: string | null;
  total: number;
  currency: string;
  expiresAt: string | null;
  itemCount: number;
  messages: ShopifyCartMessage[];
}

export interface ShopifyCheckout {
  id: string;
  status: string;
  continueUrl: string | null;
  total: number;
  currency: string;
  expiresAt: string | null;
}

export interface ShopifyAddress {
  firstName?: string;
  lastName?: string;
  streetAddress?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  phone?: string;
}

export interface ShopifyVariant {
  id: string;
  sku: string | null;
  price: number;
  currency: string;
  available: boolean;
  options: { name: string; value: string }[];
  checkoutUrl: string | null;
  seller: string | null;
}

export interface ShopifyProduct {
  id: string;
  title: string;
  seller: string | null;
  priceMin: number | null;
  priceMax: number | null;
  currency: string | null;
  available: boolean;
  variants: ShopifyVariant[];
}

// ─── JSON-RPC envelope ───────────────────────────────────────────────────────

async function callCatalog(
  toolName: string,
  catalogParams: Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const body = {
    jsonrpc: '2.0',
    method: 'tools/call',
    id: 1,
    params: {
      name: toolName,
      arguments: {
        meta: { 'ucp-agent': { profile: AGENT_PROFILE } },
        catalog: catalogParams
      }
    }
  };

  const res = await fetch(CATALOG_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(`Shopify catalog error: ${res.status} ${await res.text()}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await res.json();

  if (json.error) throw new Error(`Shopify catalog RPC error: ${JSON.stringify(json.error)}`);

  // Response lives in result.structuredContent (UCP spec)
  return json?.result?.structuredContent ?? json?.result;
}

// ─── Search ──────────────────────────────────────────────────────────────────

export async function searchCatalog(query: string, limit = 5): Promise<ShopifyProduct[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await callCatalog('search_catalog', {
    query,
    filters: { available: true }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const products: any[] = result?.products ?? result?.items ?? [];
  return products.slice(0, limit).map(parseProductSummary);
}

// ─── Product detail ──────────────────────────────────────────────────────────

export async function getProduct(
  id: string,
  selected?: { name: string; label: string }[]
): Promise<ShopifyProduct> {
  const params: Record<string, unknown> = { id };
  if (selected?.length) params.selected = selected;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await callCatalog('get_product', params);
  // get_product response: result.structuredContent.products[0] or result.product
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any = result?.products?.[0] ?? result?.product ?? result;
  return parseProductDetail(raw);
}

// ─── Parsers ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseProductSummary(p: any): ShopifyProduct {
  // price_range is top-level on search results
  const priceMin: number | null = p.price_range?.min?.amount ?? null;
  const priceMax: number | null = p.price_range?.max?.amount ?? null;
  const currency: string | null = p.price_range?.min?.currency ?? null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const variants: any[] = p.variants ?? [];
  const sellerName: string | null =
    variants[0]?.seller?.name?.trim() ?? variants[0]?.seller?.domain ?? null;

  return {
    id: p.id ?? '',
    title: p.title ?? '',
    seller: sellerName,
    priceMin,
    priceMax,
    currency,
    available: variants.some((v) => v?.availability?.available === true),
    variants: []
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseVariant(v: any): ShopifyVariant {
  // options format: [{ name: "Color", label: "Blue" }]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawOpts: any[] = v.options ?? v.selectedOptions ?? [];
  const options = rawOpts.map((o) => ({
    name: o.name ?? '',
    value: o.label ?? o.value ?? ''
  }));

  return {
    id: v.id ?? '',
    sku: v.sku ?? null,
    price: v.price?.amount ?? 0,
    currency: v.price?.currency ?? 'USD',
    available: v.availability?.available ?? false,
    options,
    checkoutUrl: v.checkout_url ?? v.checkoutUrl ?? null,
    seller: v.seller?.name?.trim() ?? v.seller?.domain ?? null
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseProductDetail(p: any): ShopifyProduct {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawVariants: any[] = p.variants ?? [];
  const variants: ShopifyVariant[] = rawVariants.map(parseVariant);

  const priceMin: number | null = p.price_range?.min?.amount ?? null;
  const priceMax: number | null = p.price_range?.max?.amount ?? null;
  const currency: string | null = p.price_range?.min?.currency ?? variants[0]?.currency ?? null;
  const sellerName: string | null = variants[0]?.seller ?? null;

  return {
    id: p.id ?? '',
    title: p.title ?? '',
    seller: sellerName,
    priceMin,
    priceMax,
    currency,
    available: variants.some((v) => v.available),
    variants
  };
}

// ─── Cart & Checkout MCP ─────────────────────────────────────────────────────

// Normalize a merchant URL/domain to https://domain (no trailing slash)
export function normalizeMerchantOrigin(merchant: string): string {
  const withProto = merchant.startsWith('http') ? merchant : `https://${merchant}`;
  return new URL(withProto).origin;
}

// Resolve MCP endpoint via /.well-known/ucp, fall back to /api/ucp/mcp
export async function getMcpEndpoint(origin: string): Promise<string> {
  try {
    const res = await fetch(`${origin}/.well-known/ucp`);
    if (res.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ucp: any = await res.json();
      const shopping = ucp?.ucp?.services?.['dev.ucp.shopping'];
      const mcp = Array.isArray(shopping) && shopping.find((s) => s.transport === 'mcp');
      if (mcp?.endpoint) return mcp.endpoint;
    }
  } catch {
    // ignore, use fallback
  }
  return `${origin}/api/ucp/mcp`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callMerchantMcp(
  endpoint: string,
  toolName: string,
  args: Record<string, unknown>,
  token?: string
): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
    // Required by Checkout MCP — the header name is Shopify-Buyer-IP (not X-Buyer-IP).
    // Source: https://community.shopify.dev/t/checkout-mcp-create-checkout-fails-with-missing-required-buyer-ip-header-despite-following-official-demo/33939
    headers['Shopify-Buyer-IP'] = '127.0.0.1';
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      id: 1,
      params: { name: toolName, arguments: args }
    })
  });

  if (!res.ok) throw new Error(`Shopify MCP error: ${res.status} ${await res.text()}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await res.json();
  if (json.error) throw new Error(`Shopify MCP RPC error: ${JSON.stringify(json.error)}`);
  return json?.result?.structuredContent ?? json?.result?.content?.[0]?.text ?? json?.result;
}

// Strip query string from variant IDs — Shopify's catalog returns
// `gid://shopify/ProductVariant/...?shop=...` but cart APIs expect the bare GID.
function stripVariantSuffix(variantId: string): string {
  const q = variantId.indexOf('?');
  return q === -1 ? variantId : variantId.slice(0, q);
}

export async function createCart(
  items: { variantId: string; quantity?: number }[],
  merchantOrigin: string
): Promise<ShopifyCart> {
  const origin = normalizeMerchantOrigin(merchantOrigin);
  const endpoint = await getMcpEndpoint(origin);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await callMerchantMcp(endpoint, 'create_cart', {
    cart: {
      line_items: items.map((item) => ({
        quantity: item.quantity ?? 1,
        item: { id: stripVariantSuffix(item.variantId) }
      }))
    },
    meta: { 'ucp-agent': { profile: CART_CHECKOUT_PROFILE } }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cart: any = result?.cart ?? result;
  const total = cart?.totals?.find((t: { type: string }) => t.type === 'total')?.amount ?? 0;
  const lineItems = cart?.line_items ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: ShopifyCartMessage[] = (cart?.messages ?? []).map((m: any) => ({
    type: m.type ?? 'info',
    code: m.code ?? '',
    content: m.content ?? ''
  }));

  return {
    id: cart?.id ?? '',
    continueUrl: cart?.continue_url ?? null,
    total,
    currency: cart?.currency ?? 'USD',
    expiresAt: cart?.expires_at ?? null,
    itemCount: lineItems.length,
    messages
  };
}

export async function createCheckout(
  cartId: string,
  merchantOrigin: string,
  token: string,
  buyer?: {
    email?: string;
    name?: string;
    country?: string;
    phone?: string;
    address?: ShopifyAddress;
  }
): Promise<ShopifyCheckout> {
  const origin = normalizeMerchantOrigin(merchantOrigin);
  const endpoint = await getMcpEndpoint(origin);
  const meta = { 'ucp-agent': { profile: CART_CHECKOUT_PROFILE } };

  // Step 0: fetch the cart (unauthenticated — Cart MCP doesn't take a token).
  // Some Shopify merchants (e.g. Lab401) require line_items + currency in the
  // checkout object even though the docs say cart_id alone is enough.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cartRes: any = await callMerchantMcp(endpoint, 'get_cart', { id: cartId, meta });
  // Note: callMerchantMcp omits Bearer header when token is undefined.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sourceCart: any = cartRes?.cart ?? cartRes;
  const cartCurrency = sourceCart?.currency ?? 'USD';
  const cartLineItems = (sourceCart?.line_items ?? []).map(
    (li: { quantity: number; item: { id: string } }) => ({
      quantity: li.quantity,
      item: { id: li.item.id }
    })
  );

  // Step 1: create checkout from cart with line_items + currency mirrored.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any = await callMerchantMcp(
    endpoint,
    'create_checkout',
    {
      cart_id: cartId,
      checkout: { currency: cartCurrency, line_items: cartLineItems },
      meta
    },
    token
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let checkout: any = result?.checkout ?? result;

  // Step 2: update with buyer info if provided (PUT semantics — must resend all fields)
  const hasBuyer = buyer && (buyer.email || buyer.name || buyer.country || buyer.phone);
  const hasAddress = buyer?.address && Object.values(buyer.address).some((v) => v);

  if (hasBuyer || hasAddress) {
    const buyerObj: Record<string, unknown> = {};
    if (buyer?.email) buyerObj.email = buyer.email;
    if (buyer?.phone) buyerObj.phone = buyer.phone;
    if (buyer?.name) {
      const parts = buyer.name.trim().split(/\s+/);
      buyerObj.first_name = parts[0];
      if (parts.length > 1) buyerObj.last_name = parts.slice(1).join(' ');
    }

    // Build the fulfillment object with shipping destination from the address.
    // Shopify's UCP spec: fulfillment.methods[].destinations[] holds shipping
    // addresses. When all required fields are present, the checkout can skip
    // the address-entry step and land the buyer directly on payment.
    let fulfillmentObj: Record<string, unknown> | undefined;
    if (hasAddress && buyer?.address) {
      const a = buyer.address;
      const destName = buyer.name?.trim().split(/\s+/) ?? [];
      const destination: Record<string, unknown> = {};
      if (a.firstName || destName[0]) destination.first_name = a.firstName ?? destName[0];
      if (a.lastName || destName.slice(1).length)
        destination.last_name = a.lastName ?? destName.slice(1).join(' ');
      if (a.streetAddress) destination.street_address = a.streetAddress;
      if (a.city) destination.address_locality = a.city;
      if (a.region) destination.address_region = a.region;
      if (a.postalCode) destination.postal_code = a.postalCode;
      if (a.country) destination.address_country = a.country;
      if (a.phone || buyer.phone) destination.phone = a.phone ?? buyer.phone;

      fulfillmentObj = {
        methods: [{ type: 'shipping', destinations: [destination] }]
      };
    }

    const updateArgs: Record<string, unknown> = {
      id: checkout?.id,
      checkout: {
        currency: checkout?.currency ?? 'USD',
        context: buyer?.country ? { country: buyer.country } : undefined,
        line_items: (checkout?.line_items ?? []).map(
          (li: { quantity: number; item: { id: string } }) => ({
            quantity: li.quantity,
            item: { id: li.item.id }
          })
        ),
        buyer: buyerObj,
        ...(fulfillmentObj ? { fulfillment: fulfillmentObj } : {})
      },
      meta
    };

    result = await callMerchantMcp(endpoint, 'update_checkout', updateArgs, token);

    checkout = result?.checkout ?? result;
  }

  const total = checkout?.totals?.find((t: { type: string }) => t.type === 'total')?.amount ?? 0;

  return {
    id: checkout?.id ?? '',
    status: checkout?.status ?? 'unknown',
    continueUrl: checkout?.continue_url ?? null,
    total,
    currency: checkout?.currency ?? 'USD',
    expiresAt: checkout?.expires_at ?? null
  };
}

# @polymarket/client@0.12.0 API reference sheet

Source of truth: `node_modules/@polymarket/client/dist/*.d.ts` and `node_modules/@polymarket/bindings/dist/**/*.d.ts`
in `scratchpad/dwspike`, plus runtime probes (`probe1.mjs`..`probe4.mjs`) and a `tsc --strict` check (`tc.ts`)
run on 2026-10-08 against production. Legend: **[V]** = verified at runtime or by tsc, **[D]** = read from .d.ts
only, **[I]** = inferred from minified runtime source, **[?]** = not confirmed.

Package facts: ESM only (`"type": "module"`), `engines.node >= 24`. Peer: `viem` (for `/viem` subpath), `zod` v4
schemas internally. Ids such as `TokenId`, `PositionId`, `ConditionId`, `DecimalString`, `BaseUnits`, `MarketId`,
`EventId`, `OrderId` are **tagged strings** (plain strings at runtime; assignable to `string`).

---

## 1. Imports

```ts
// root
import {
  createPublicClient, createSecureClient, production, forkEnvironmentConfig,
  relayerApiKey, remoteBuilderSigning, buildHmacSignature, makeErrorGuard,
  // enums (re-exported from @polymarket/bindings/*)
  OrderSide, OrderType, SignatureType, AssetType, OrderPostStatus, OrderResponseErrorCode,
  PriceHistoryInterval, PositionStatus, PositionSortBy, SortDirection, ActivityType,
  UserPnlInterval, UserPnlFidelity, WalletType, ProtocolVersion, SearchSort, SignerType,
  // error classes
  UserInputError, RequestRejectedError, RateLimitError, TransportError, UnexpectedResponseError,
  TimeoutError, TransactionFailedError, SigningError, CancelledSigningError,
  InsufficientLiquidityError, PaginationLimitError, OperationAbortedError, ConnectionLostError,
  // per-action error unions (value + type), e.g.
  CreateSecureClientError, EstimateMarketPriceError, PlaceMarketOrderError, PlaceLimitOrderError,
  CancelOrderError, RedeemPositionsError, TransferErc20Error, SetupTradingApprovalsError,
  // types
  type PublicClient, type SecureClient, type SecureClientOptions, type PublicClientOptions,
  type Signer, type TransactionHandle, type TransactionOutcome, type Paginated, type Page,
  type Market, type Event, type OrderBook, type OrderResponse, type AcceptedOrderResponse,
  type OpenOrder, type Position, type Activity, type PriceHistoryPoint, type ApiKeyCreds,
  type EnvironmentContracts, type AccountIdentity,
  type PrepareMarketOrderRequest, type PrepareLimitOrderRequest, type EstimateMarketPriceRequest,
  type PrepareRedeemPositionsRequest, type PrepareErc20TransferRequest,
} from '@polymarket/client';

import { privateKey, signerFrom } from '@polymarket/client/viem';   // signerFrom(walletClient: viem WalletClient): Signer
import { builderApiKey } from '@polymarket/client/node';            // also '@polymarket/client/ethers-v5', '/privy'
import {
  createBuilderApiKey, fetchBuilderApiKeys, revokeBuilderApiKey,
  createApiKey, deriveApiKey, createOrDeriveApiKey, fetchApiKeys, deleteApiKey,
  fetchBalanceAllowance, updateBalanceAllowance, deployDepositWallet, isWalletDeployed,
  fetchTransaction, prepareGaslessTransaction, fetchTickSize, fetchNegRisk, fetchMarketInfo,
  resolveConditionByToken, /* every client method also exists here as fn(client, req) */
} from '@polymarket/client/actions';
```

Runtime also exports `preproduction` from the root, but it is not in the .d.ts **[V]**.

### Signatures of the helpers

```ts
function privateKey(value: PrivateKey | string | undefined, options?: { chain?: viem.Chain; transport?: viem.Transport }): Signer; // [D] chain/transport only used for direct EOA txs
function builderApiKey(options: { key: string; secret: string; passphrase: string }): ApiKeyAuthorization;            // [D]
function relayerApiKey(config: { key: string; address: string }): ApiKeyAuthorization;                                  // [D]
function remoteBuilderSigning(config: { url: string; credentials?: RequestCredentials;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>) }): ApiKeyAuthorization;                          // [D]
function createBuilderApiKey(client: BaseSecureClient): Promise<BuilderApiKeyCreds>;  // { key: ApiKey; secret: string; passphrase: string } [D]
function fetchBuilderApiKeys(client: BaseSecureClient): Promise<BuilderApiKey[]>;     // { key, createdAt?, revokedAt? } [D]
function revokeBuilderApiKey(client: BaseClient): Promise<void>;                       // [D]
function deployDepositWallet(client: BaseSecureClient): Promise<TransactionHandle>;    // requires apiKey (see 2.3) [D][I]
function isWalletDeployed(client: BaseClient, request?: { wallet: string; type: WalletType }): Promise<boolean>; // [D]
function fetchBalanceAllowance(client: BaseSecureClient, request: { assetId?: string; assetType: AssetType }):
  Promise<{ balance: BaseUnits /* string, base units */; allowances: Record<EvmAddress, bigint> }>;               // [D]
function updateBalanceAllowance(client: BaseSecureClient, request: same): Promise<same>;                           // [D] refreshes CLOB's cached view
```

`fetchBalanceAllowance` / `updateBalanceAllowance` are **not** methods on the client instance; call them from
`/actions` **[V tsc]**. For collateral: `fetchBalanceAllowance(client, { assetType: AssetType.COLLATERAL })`.
Alternative: read pUSD `balanceOf(client.account.wallet)` with viem.

### Error detection **[V]**

Every error class extends `PolymarketError` (from `@polymarket/types`) and has a static `isError`. Every action
also exports a same-named const with `isError` covering its union.

```ts
try { await client.placeMarketOrder(req); }
catch (e) {
  if (RequestRejectedError.isError(e)) { e.status; e.code; e.retryAfter; e.restriction /* 'restarting'|'post_only' */; }
  else if (RateLimitError.isError(e)) { e.retryAfter; e.rateLimit; }
  else if (InsufficientLiquidityError.isError(e)) { /* book too thin (FOK) */ }
  else if (UserInputError.isError(e)) { /* zod validation, message lists issues */ }
}
const isNetOrRate = makeErrorGuard(TransportError, RateLimitError).isError; // (e: unknown) => e is TransportError | RateLimitError
```

Verified: `RequestRejectedError.isError(new UserInputError('x'))` returned `true` at runtime, so the static
`isError` inherited from the base matches **any PolymarketError**, not only that class. Use `makeErrorGuard(X)` or
`e instanceof X` / `e.name === 'RequestRejectedError'` to discriminate by class. Similarly
`makeErrorGuard(RequestRejectedError, UserInputError).isError(new UserInputError())` → true (expected).
404 sample: `fetchMarket({slug:'nope'})` → `RequestRejectedError`, `status: 404`, `code: undefined`,
message `"slug not found (https://gamma-api.polymarket.com/markets/slug/...)"` **[V]**.
Error classes: `UserInputError`, `PaginationLimitError`, `UnexpectedResponseError`, `TransportError`,
`ConnectionLostError`, `RequestRejectedError {status, code?, retryAfter?, restriction?}`,
`RateLimitError {retryAfter?, rateLimit?}`, `TimeoutError`, `OperationAbortedError`, `TransactionFailedError`,
`CancelledSigningError`, `InsufficientLiquidityError`, `SigningError`, `AutoCancelDailyLimitError`, `PerpsCancelRetryError`.

### Enums (runtime values) **[V]**

```ts
enum OrderSide { BUY = 'BUY', SELL = 'SELL' }
enum OrderType { GTC = 'GTC', FOK = 'FOK', GTD = 'GTD', FAK = 'FAK' }
enum SignatureType { EOA = 0, POLY_PROXY = 1, POLY_GNOSIS_SAFE = 2, POLY_1271 = 3 }
enum PriceHistoryInterval { Max = 'max', OneMonth = '1m', OneWeek = '1w', OneDay = '1d', SixHours = '6h', OneHour = '1h' }
enum AssetType { COLLATERAL = 'COLLATERAL', CONDITIONAL = 'CONDITIONAL', CONDITIONAL_V2 = 'CONDITIONAL-V2' }   // [D]
enum OrderPostStatus { LIVE = 'live', MATCHED = 'matched', DELAYED = 'delayed' }                               // [D]
enum OrderResponseErrorCode { UNMATCHED='unmatched', MARKET_NOT_READY='market_not_ready',
  INSUFFICIENT_BALANCE_OR_ALLOWANCE='insufficient_balance_or_allowance', INVALID_NONCE='invalid_nonce',
  INVALID_EXPIRATION='invalid_expiration', POST_ONLY_WOULD_CROSS='post_only_would_cross',
  POST_ONLY_MODE='post_only_mode', FOK_NOT_FILLED='fok_not_filled', FAK_NOT_FILLED='fak_not_filled', UNKNOWN='unknown' } // [D]
enum WalletType { EOA = 0, POLY_PROXY = 1, GNOSIS_SAFE = 2, DEPOSIT_WALLET = 3 }                              // [D]
enum SignerType { OWNER = 'OWNER', SESSION_KEY = 'SESSION_KEY' }                                               // [D]
enum ProtocolVersion { V1 = 'v1', V2 = 'v2' }                                                                  // [D]
enum PositionStatus { Open='OPEN', Redeemable='REDEEMABLE', RedeemableLost='REDEEMABLE_LOST', Mergeable='MERGEABLE', Closed='CLOSED' } // [D]
enum PositionSortBy { CurrentValue='CURRENT_VALUE', Tokens='TOKENS', UnrealizedPnl='UNREALIZED_PNL', RealizedPnl='REALIZED_PNL', TotalPnl='TOTAL_PNL', Timestamp='TIMESTAMP' }
enum SortDirection { Asc = 'ASC', Desc = 'DESC' }
enum UserPnlInterval { Max='max', OneMonth='1m', OneWeek='1w', OneDay='1d', TwelveHours='12h', SixHours='6h' }
enum UserPnlFidelity { OneDay='1d', EighteenHours='18h', TwelveHours='12h', ThreeHours='3h', OneHour='1h' }
enum ActivityType { TRADE, SPLIT, MERGE, REDEEM, REWARD, CONVERSION, MIGRATION, MAKER_REBATE, REFERRAL_REWARD, YIELD, DEPOSIT, WITHDRAWAL, ... } // string values = names
enum SearchSort { Volume='volume', Volume24Hr='volume_24hr', Liquidity='liquidity', Competitive='competitive', ClosedTime='closed_time', StartDate='start_date', EndDate='end_date' }
```

---

## 2. Clients

### 2.1 Options **[D]**

```ts
type PublicClientOptions = {
  environment?: EnvironmentConfig;            // default `production`
  apiKey?: ApiKeyAuthorization;               // builderApiKey(...) | relayerApiKey(...) | remoteBuilderSigning(...)
  onRateLimitUpdate?: (u: RateLimitUpdate) => void;
};
type SecureClientOptions = PublicClientOptions & {
  wallet?: string;   // omit => signer's deterministic Deposit Wallet. Pass the signer address to trade as EOA,
                     // or an existing Poly Deposit Wallet / Safe / Proxy address to use as funder.
  signer: Signer;
} & ({ credentials?: ApiKeyCreds; nonce?: never } | { credentials?: never; nonce?: number /* default 0 */ });

type ApiKeyCreds = { key: ApiKey; secret: string; passphrase: string };   // CLOB L2 creds (output shape) [D]

function createPublicClient(options?: PublicClientOptions): PublicClient;            // sync
function createSecureClient(options: SecureClientOptions): Promise<SecureClient>;     // throws CreateSecureClientError
```

`Signer` (implement this to plug in a non-viem wallet, e.g. OMS):
```ts
type Signer = {
  getAddress(): Promise<EvmAddress>;
  signTypedData(payload: { domain: TypedDataDomain; message: Record<string, unknown>; primaryType: string;
                           types: Record<string, readonly { name: string; type: string }[]> }): Promise<EvmSignature>;
  signMessage(message: HexString): Promise<EvmSignature>;
  sendTransaction(request: { chainId: number; data?: HexString; to: EvmAddress; value?: bigint }): Promise<TransactionHandle>;
};
```

### 2.2 Instance properties

```ts
secureClient.account: AccountIdentity   // [V tsc]
  // { signer: EvmAddress  (EOA that signs),
  //   signerType: SignerType,
  //   wallet: EvmAddress  (account/funder = deposit wallet by default; balances, positions, orders use this),
  //   walletType: WalletType }
secureClient.credentials: ApiKeyCreds   // persist this and pass back as `credentials` to skip the auth signature [D]
secureClient.endAuthentication(): Promise<PublicClient>   // REVOKES current creds [D]
client.isSecureClient() / client.isPublicClient() / client.closeSubscriptions() / client.extend(decorator)
```

**Contracts / environment.** At runtime `client.environment` exists (a protected getter) and holds
`{ name, chainId: 137, rpc: 'https://polygon.drpc.org', walletDerivation, contracts, clob, relayer, gamma, data, ... }`,
but in TypeScript `client.environment` is **a type error** (TS2339), and `production.contracts` is also a type
error because `EnvironmentConfig` is declared as only `{ name: string; chainId: number }` **[V tsc]**. The .d.ts
examples that use `client.environment.contracts.collateralToken` do not compile. Use a cast or constants:

```ts
const contracts = (production as unknown as { contracts: EnvironmentContracts }).contracts;
```

Production contracts **[V]**:
```
collateralToken          0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB   // pUSD, "Polymarket USD", 6 decimals [V on-chain]
conditionalTokens        0x4D97DCd97eC945f40cF65F87097ACe5EA0476045
negRiskAdapter           0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296
collateralAdapter        0xAdA100Db00Ca00073811820692005400218FcE1f
negRiskCollateralAdapter 0xadA2005600Dec949baf300f4C6120000bDB6eAab
standardExchange         0xE111180000d2663C0091e4f400237545B87B996B
negRiskExchange          0xe2222d279d744050d28e00520010520000310F59
exchangeV3               0xe3333700cA9d93003F00f0F71f8515005F6c00Aa
protocolV2Router         0x12121212006e4CD160D18e3f00711DA5c3372600
positionManager 0x006F54F7f9A22e0000CC2AB60031000000ae9fEF   autoRedeemOperator 0xa1200000d0002264C9a1698e001292D00E1b00af
relayHub 0xD216153c06E857cD7f72665E0aF1d7D82172F494          depositWalletFactory 0x00000000000Fb5C9ADea0298D729A0CB3823Cc07
```
Endpoints: clob `https://clob.polymarket.com`, relayer `https://relayer-v2.polymarket.com`,
gamma `https://gamma-api.polymarket.com`, data `https://data-api.polymarket.com`.

### 2.3 What `createSecureClient` does **[I]** (from minified `index.js`)

1. Builds a public client with `environment`/`apiKey`.
2. Resolves the wallet: `options.wallet` if given; else derives the signer's Deposit Wallet address (checks a
   legacy derivation first, uses it if already deployed, otherwise the current factory derivation).
3. `beginAuthentication`: if `credentials` given and still listed by the CLOB they are reused; otherwise the
   signer signs a ClobAuth EIP-712 message (with `nonce`, default 0) and API creds are created/derived.
4. If `walletType === EOA` or the wallet is already deployed → returns.
   If it is the derived Deposit Wallet and not deployed → calls `deployDepositWallet` via the relayer and
   **awaits `.wait()`** before returning. Otherwise throws `UserInputError`-like "Wallet ... does not exist".
5. Deployment (and every gasless tx: approvals, transfers, redeem) asserts `client.supportsGasless`, which is
   true only when `apiKey` is a builder or relayer key. Message: *"Deposit Wallet deployment requires a Relayer
   API Key or Builder API Key in the client configuration."* So a Deposit-Wallet secure client **must** be
   created with `apiKey: builderApiKey(...)` (or relayer/remote) unless the wallet is already deployed.

Bootstrapping a builder key **[I, not executed]**: `createBuilderApiKey` needs a `BaseSecureClient`. A plausible
path with no prior key is an EOA-mode client (`wallet: await signer.getAddress()`, no deploy needed) →
`createBuilderApiKey(eoaClient)` → then `createSecureClient({ signer, apiKey: builderApiKey(creds) })`, which
deploys the Deposit Wallet. Whether a builder key minted under the EOA identity is accepted for the deposit
wallet's relayer calls is **[?]**.

---

## 3. Methods

All list methods return `Paginated<T>` synchronously (no `await` on the call itself) **[V]**:
```ts
type Page<T> = { items: T; hasMore: boolean; limitReached?: boolean; nextCursor?: PaginationCursor; totalCount?: number };
type Paginated<T> = AsyncIterable<Page<T>> & { firstPage(): Promise<Page<T>>; from(cursor?: PaginationCursor): Paginated<T> };

const first = await client.listMarkets({ pageSize: 5 }).firstPage();     // first.items: Market[]
for await (const page of client.search({ q: 'bitcoin', pageSize: 2 })) { /* page.items.events */ break; }
const next = client.listMarkets({ pageSize: 5 }).from(first.nextCursor);
```

### 3.1 Discovery (public + secure) **[D, shapes V]**

```ts
fetchMarket(req: { id: string } | { slug: string } | { url: string }  /* + includeTag?, locale? */): Promise<Market>;
fetchEvent(req: { id: string } | { slug: string } | { url: string }  /* + includeBestLines?, includeChat?, includeTemplate?, locale? */): Promise<Event>;
listMarkets(req?: ListMarketsRequest): Paginated<Market[]>;
listEvents(req?: ListEventsRequest): Paginated<Event[]>;
search(req: SearchRequest): Paginated<{ events: Event[]; profiles: Profile[]; tags: SearchTag[] }>;
```
No fetch-by-conditionId: use `listMarkets({ conditionIds: [cid] })` **[V]** (returned the single market).
`fetchMarket({ id })` takes a string id, e.g. `'637002'` **[V]**. Also by token: `listMarkets({ clobTokenIds: [...] })`
or `/actions` `resolveConditionByToken`.

`ListMarketsRequest` (all optional): `ascending, closed, clobTokenIds: string[], cursor, pageSize, conditionIds: string[],
cyom, decimalized, endDateMax/endDateMin/startDateMax/startDateMin: string|Date, gameId, ids: number[], includeTag,
liquidityNumMax/Min, locale, order: string /* e.g. 'volume24hr' [V] */, positionIds: string[], questionIds: string[],
relatedTags, rfqEnabled, rewardsMinSize, slug: string[], sportsMarketTypes: string[], tagId: number,
tagMatch: 'any'|'all', umaResolutionStatus, volumeNumMax/Min`.

`SearchRequest`: `q: string` (required), `ascending?, cache?, cursor?, eventsStatus?: string, eventsTag?: string[],
excludeTagIds?: number[], keepClosedMarkets?: number, optimized?, pageSize?: number (has default), presets?: string[],
recurrence?: 'daily'|'weekly'|'monthly', searchProfiles?, searchTags?, sort?: SearchSort`.
Note: search for 'bitcoin' returned closed events first (`state.closed: true`) **[V]**; filter on
`event.state.closed` / market `state.acceptingOrders`. Accepted values of `eventsStatus` are **[?]**.

#### `Market` (gamma, normalized; not the raw gamma JSON) **[V]**
```ts
type Market = {
  id: MarketId; version?: 'v1'|'v2'|null; slug?: string|null; conditionId: ConditionId|null;
  question?, groupItemTitle?, description?, category?, image?, icon?: string|null;
  state: { active?, closed?, archived?, acceptingOrders?, enableOrderBook?, negRisk?: boolean|null;
           comboStatus?; startDate?, endDate?, closedTime?: IsoDateTimeString|null };
  outcomes: { yes: MarketOutcome; no: MarketOutcome };   // ALWAYS binary yes/no
  prices: { bestBid?, bestAsk?, lastTradePrice?, spread?, oneHourPriceChange?, oneDayPriceChange?,
            oneWeekPriceChange?, oneMonthPriceChange?, oneYearPriceChange?: DecimalString|null };
  trading: { minimumOrderSize?: DecimalString|null; minimumTickSize?: 0.1|0.01|0.005|0.0025|0.001|0.0001|null;
             secondsDelay?; feesEnabled?; feeType?; feeSchedule?: { exponent, rate, takerOnly, rebateRate } };
  metrics: { volume?, volumeNum?, volume24hr?, volume1wk?, volume1mo?, volume1yr?, volumeClob?, liquidity?, liquidityNum?, liquidityClob? };
  resolution: { questionId; negRiskRequestId; umaResolutionStatus; source?; resolvedBy };
  rewards; sports; events: { id: EventId; slug: string|null; title: string|null }[]; tags;
  positionIds: PositionId[];   // @deprecated
};
type MarketOutcome = { label: string; tokenId: TokenId|null /* CTF token = CLOB asset id for v1 */;
                       positionId: PositionId|null /* V2 position id */; price: DecimalString|null };
```
Runtime keys: `id, version, slug, conditionId, question, groupItemTitle, description, category, image, icon, state,
outcomes, metrics, prices, trading, resolution, rewards, sports, events, positionIds, tags`.
There is no `outcomes[]` string array and no `clobTokenIds` / `outcomePrices` / `negRisk` at top level: use
`outcomes.yes.tokenId`, `outcomes.yes.price`, `state.negRisk`, `state.acceptingOrders`.

Sample (trimmed) **[V]**:
```json
{ "id": "637002", "version": "v1", "slug": "will-donald-trump-win-the-nobel-peace-prize-in-2026-382",
  "conditionId": "0x962e5b22…945f", "question": "Will Donald Trump win the Nobel Peace Prize in 2026?",
  "state": { "active": true, "closed": false, "archived": false, "comboStatus": "enabled", "acceptingOrders": true,
             "enableOrderBook": true, "negRisk": true, "startDate": "2025-10-16T22:30:32.369842Z", "endDate": "2027-04-01T03:59:00Z" },
  "outcomes": { "yes": { "label": "Yes", "tokenId": "963085561097…988516", "positionId": "1196114616…699456", "price": "0.0045" },
                "no":  { "label": "No",  "tokenId": "756485535997…485336", "positionId": "1196114616…699457", "price": "0.9955" } },
  "prices": { "bestBid": "0.004", "bestAsk": "0.005", "lastTradePrice": "0.004", "spread": "0.001", "oneDayPriceChange": "-0.004" },
  "trading": { "minimumOrderSize": "5", "minimumTickSize": 0.001, "feesEnabled": true, "feeType": "culture_fees",
               "feeSchedule": { "exponent": 1, "rate": "0.05", "takerOnly": true, "rebateRate": "0.25" } },
  "events": [ { "id": "60182", "slug": "nobel-peace-prize-winner-2026-139", "title": "Nobel Peace Prize Winner 2026" } ] }
```
All top-50 open markets by 24h volume were `version: "v1"`; no v2 market was found to test **[V]**.
For a v1 market, `fetchOrderBook({ assetId: outcomes.yes.positionId })` → 404; use `tokenId` **[V]**. Rule of thumb:
`assetId = market.version === 'v2' ? outcome.positionId : outcome.tokenId` **[I]** (v2 path untested).

#### `Event` **[V]**
Runtime keys: `id, version, parentEventId, ticker, slug, title, subtitle, description, category, subcategory, image, icon,
featuredImage, createdAt, updatedAt, publishedAt, state, schedule, metrics, display, trading, resolution, estimation,
sports, partners, metadata, markets: Market[], series, tags, creators`.
```json
{ "id": "60182", "version": "v1", "slug": "nobel-peace-prize-winner-2026-139", "title": "Nobel Peace Prize Winner 2026",
  "state": { "active": true, "closed": false, "archived": false, "new": false, "featured": true, "restricted": true, "cyom": false, "automaticallyActive": true },
  "trading": { "enableOrderBook": true, "negRisk": true, "negRiskMarketId": "0x09139f…bf00", "enableNegRisk": true, "negRiskAugmented": true, "cumulativeMarkets": false },
  "schedule": { "startDate": "2025-10-16T22:30:31.859771Z", "creationDate": "2025-10-16T22:33:46.896353Z", "endDate": "2027-04-01T03:59:00Z" },
  "metrics": { "liquidity": "1975577.87682", "volume": "27875559.31", "volume24hr": "1116312.59", "openInterest": "3737081.37", "competitive": 0.90, "commentCount": 221 },
  "markets": "[71 Market objects, same shape as above]" }
```

### 3.2 Market data (public + secure) **[D, V]**

All take `{ assetId: string }` (deprecated alias `tokenId`; never pass both).
```ts
fetchOrderBook(req: { assetId }): Promise<OrderBook>;
fetchOrderBooks(req): Promise<OrderBook[]>;
fetchPrice(req: { assetId; side: OrderSide }): Promise<DecimalString>;
fetchMidpoint(req: { assetId }): Promise<DecimalString>;
fetchSpread(req: { assetId }): Promise<DecimalString>;
fetchLastTradePrice(req: { assetId }): Promise<{ price: DecimalString; side: string } | null>;
listPriceHistory(req: ListPriceHistoryRequest): Paginated<PriceHistoryPoint[]>;
estimateMarketPrice(req: EstimateMarketPriceRequest): Promise<number>;
fetchTradingApprovalsState(req: { user: string }): Promise<TradingApprovalsState>;  // public variant
```
Verified outputs for the YES token above (bestBid 0.004, bestAsk 0.005):
`fetchPrice BUY → "0.004"`, `fetchPrice SELL → "0.005"` (CLOB semantics: BUY returns the best **bid**, SELL the best
**ask**; for "what would I pay to buy" use `estimateMarketPrice` or `prices.bestAsk`), `fetchMidpoint → "0.0045"`,
`fetchSpread → "0.001"` (string), `fetchLastTradePrice → { price: "0.004", side: "SELL" }`.

```ts
type OrderBook = { assetId; tokenId /*deprecated*/; conditionId: ConditionId; timestamp?: number|null /* epoch ms */;
  bids: { price: DecimalString; size: DecimalString }[];  // ascending price: BEST BID IS LAST
  asks: { price: DecimalString; size: DecimalString }[];  // descending price: BEST ASK IS LAST
  minOrderSize: DecimalString; tickSize: number; negRisk: boolean; lastTradePrice?: DecimalString|null; hash: string };
```
Sample **[V]**: `{ timestamp: 1791478449000, bids: [{price:"0.001",size:"37648.85"},{price:"0.002",...},...(4)],
asks: [{price:"0.999",size:"11006443.88"},{price:"0.998",...},...(136)], minOrderSize: "5", tickSize: 0.001, negRisk: true,
lastTradePrice: "0.996", hash: "0a921a…" }`. Best bid = `bids.at(-1)`, best ask = `asks.at(-1)`.

`EstimateMarketPriceRequest`:
```ts
| { assetId: string; side: OrderSide.BUY;  amount: number|string /* USD to spend */;   orderType?: OrderType.FAK|OrderType.FOK /* default FOK */ }
| { assetId: string; side: OrderSide.SELL; shares: number|string /* shares to sell */; orderType?: OrderType.FAK|OrderType.FOK }
```
Returns the worst price level crossed, as a `number` **[V]**: BUY amount 5 → `0.005`; SELL shares 5 → `0.004`.
BUY amount 1e12 → throws `InsufficientLiquidityError` (FOK) **[V]**. With FAK it may return a partial-fill price.

`ListPriceHistoryRequest` (three exclusive shapes):
```ts
| { assetId: string; interval: PriceHistoryInterval; bucketSeconds?: number; cursor?; pageSize? }
| { assetId: string; start: number|Date; end?: number|Date; bucketSeconds?: number; cursor?; pageSize? }
| { assetId: string; asOf: number|Date }        // single point
```
Numbers are **Unix seconds** (passing ms fails validation: "asOf: Too big: expected number to be <=253402300799") **[V]**.
`type PriceHistoryPoint = { timestamp: number /* epoch ms */; price: DecimalString; resolutionSeconds: number }`.
Verified: `interval: OneDay` → 1435 points at 60s resolution, `hasMore: false`, oldest first;
`interval: OneWeek, bucketSeconds: 3600` → 168 points, last point `resolutionSeconds: 0` (live tick);
`start: now-3h, bucketSeconds: 600` → 18 points; `asOf` → `items: [one point]`.
Page keys at runtime: `items, hasMore, nextCursor` (one page covered the whole range in all tests).

### 3.3 Trading (secure only) **[D; shapes tsc-checked; not executed]**

```ts
placeMarketOrder(req: PrepareMarketOrderRequest): Promise<OrderResponse>;
placeLimitOrder(req: PrepareLimitOrderRequest): Promise<OrderResponse>;
createMarketOrder(req): Promise<SignedOrder>;  createLimitOrder(req): Promise<SignedOrder>;   // sign only
postOrder(order: SignedOrder): Promise<OrderResponse>;  postOrders(orders: SignedOrder[] /* 1..15 */): Promise<OrderResponse[]>;
waitForOrderFillSettlement(order: AcceptedOrderResponse, req?: { timeoutMs?: number /* 30000 */ }): Promise<TxHash[]>;
cancelOrder(req: { orderId: string }): Promise<CancelOrdersResponse>;
cancelOrders(req: { orderIds: string[] }): Promise<CancelOrdersResponse>;
cancelAll(): Promise<CancelOrdersResponse>;
cancelMarketOrders(req: { market?: string /* conditionId */; assetId?: string }): Promise<CancelOrdersResponse>;
listOpenOrders(req?: { market?: string; assetId?: string; id?: string; cursor?: string }): Paginated<OpenOrder[]>;
fetchOrder(req: { orderId: string }): Promise<OpenOrder>;
fetchClosedOnlyMode(): Promise<boolean>;
listAccountTrades(req?: { assetId?, market?, id?, makerAddress?, before?, after?, cursor?: string }): Paginated<ClobTrade[]>;
```

```ts
type PrepareMarketOrderRequest =
 | { assetId: string; side: OrderSide.BUY;
     amount: number|string;        // USD notional BEFORE taker fees (fees added on top)
     maxSpend?: number|string;     // all-in USD cap incl. fees; SDK shrinks amount to fit
     maxPrice?: number|string;     // slippage protection (worst price per share)
     builderCode?: string; orderType?: OrderType.FAK|OrderType.FOK /* default FAK */ }
 | { assetId: string; side: OrderSide.SELL;
     shares: number|string;        // outcome shares
     minPrice?: number|string; builderCode?: string; orderType?: OrderType.FAK|OrderType.FOK /* default FAK */ };

type PrepareLimitOrderRequest = {
  assetId: string; side: OrderSide;
  price: number|string;            // per share
  size: number|string;             // SHARES (not USD)
  builderCode?: string;
  postOnly?: boolean;              // default false
  expiration?: number;             // Unix SECONDS, >= now + 3 min; makes it GTD. Omit => GTC.
};                                 // there is NO orderType field on limit orders
```
Note the deprecated `tokenId` alias exists on every request; `assetId` and `tokenId` are mutually exclusive (`never`).

```ts
type OrderResponse =
 | { ok: true; orderId: OrderId; status: OrderPostStatus /* 'live'|'matched'|'delayed' */;
     makingAmount: DecimalString; takingAmount: DecimalString;   // '0' if no fill at placement
     transactionsHashes: TxHash[] /* best effort, may be empty */; tradeIds: string[] }        // AcceptedOrderResponse
 | { ok: false; code: OrderResponseErrorCode; message: string };                                 // RejectedOrderResponse
type CancelOrdersResponse = { canceled: OrderId[]; notCanceled: Record<OrderId, string /* reason */> };
type OpenOrder = { id: string; assetId; tokenId; conditionId: ConditionId; owner: string; makerAddress: string;
  side: string; price: DecimalString; originalSize: DecimalString; sizeMatched: DecimalString; outcome: string;
  orderType: string; status: string; associateTrades: string[]; createdAt: IsoDateTimeString; expiresAt?: IsoDateTimeString };
```
Venue rejections come back as `ok: false` (not thrown); transport/auth/validation problems throw
(`PlaceMarketOrderError` / `PlaceLimitOrderError` union). Note the field is spelled `transactionsHashes`.

### 3.4 Wallet operations (secure only) **[D; tsc-checked; not executed]**

```ts
fetchTradingApprovalsState(): Promise<TradingApprovalsState>;   // secure overload: own wallet
setupTradingApprovals(): Promise<void>;                          // grants every missing approval (gasless batch for deposit wallet/safe/proxy; per-tx for EOA) and waits
approveErc20(req: { amount: bigint | 'max'; spenderAddress: string; tokenAddress: string; metadata?: string }): Promise<TransactionHandle>;
approveErc1155ForAll(req: { operatorAddress: string; tokenAddress: string; approved?: boolean /* default true */; metadata?: string }): Promise<TransactionHandle>;
transferErc20(req: PrepareErc20TransferRequest): Promise<TransactionHandle>;
redeemPositions(req: PrepareRedeemPositionsRequest): Promise<TransactionHandle>;
splitPosition(req): Promise<TransactionHandle>;  mergePositions(req): Promise<TransactionHandle>;
planCollateralReturn(); executeCollateralReturnPlan({ plan });
```
```ts
type PrepareErc20TransferRequest = { amount: bigint /* base units; pUSD has 6 decimals */; recipientAddress: string;
                                     tokenAddress: string; metadata?: string };
type PrepareRedeemPositionsRequest =
 | { conditionId: string; metadata?: string }     // CTF or V2 market; SDK resolves protocol
 | { marketId: string;    metadata?: string }     // gamma market id, e.g. '637002'
 | { positionId: string;  metadata?: string };    // specific V2 position
type TransactionHandle = { readonly transactionHash: TxHash | null; readonly transactionId: TransactionId | null;
                           wait(): Promise<{ transactionHash: TxHash; transactionId: TransactionId | null }> };
// wait() throws WaitForTransactionError = RateLimit|RequestRejected|Transport|UnexpectedResponse|UserInput|Timeout|TransactionFailed
type TradingApprovalsState = { isFullyApproved: boolean;
  missing: { erc20: { amount: bigint; spenderAddress; tokenAddress }[]; erc1155: { operatorAddress; tokenAddress }[] } };
```
`fetchTradingApprovalsState({ user })` on a fresh address **[V]**: `isFullyApproved: false`, 7 erc20 entries (pUSD →
standardExchange, negRiskExchange, collateralAdapter, …, amount = 2^256-1 as `bigint`), 10 erc1155 entries
(conditionalTokens → exchanges/adapters, …). Remember `bigint` does not `JSON.stringify`.
Gasless ops require `apiKey` (builder/relayer) on the client and a Deposit Wallet / Safe / Proxy account **[I]**.
There is no deposit-wallet deploy method on the instance; `createSecureClient` deploys automatically (2.3), or
call `deployDepositWallet(client)` from `/actions`.

### 3.5 Account data (Data API) **[D]**

On a public client `user` is required; on a secure client every request is optional and `user` defaults to
`client.account.wallet` (`DefaultAccountWallet<…>`).
```ts
listPositions(req?: { user?; conditionId?: string|string[]; status?: PositionStatus; eventId?: (string|number)[];
  filterType?; filterAmount?: number; includeArchived?: boolean; sortBy?: PositionSortBy; sortDirection?: SortDirection;
  window?: 'full' | { start?: number|Date; end?: number|Date }; pageSize?; cursor? }): Paginated<Position[]>;
listActivity(req?: { user?; conditionId?; eventId?; type?: ActivityType[]; side?: OrderSide; sortDirection?; window?; pageSize?; cursor? }): Paginated<Activity[]>;
fetchPortfolioValue(req?: { user?; conditionIds?: string[] }): Promise<{ wallet: EvmAddress; value: DecimalString /* USD */ }>;
fetchUserPnl(req?: { user?; interval?: UserPnlInterval; fidelity?: UserPnlFidelity }): Promise<UserPnlSeries>;
fetchUserStats(req?): Promise<UserStats | null>;  fetchUserVolume(req?): Promise<UserVolume>;
listComboPositions / listComboActivity / downloadAccountingSnapshot(req?): Promise<Blob>;
```
```ts
type Position = { wallet; assetId; tokenId; conditionId; currentSize /* shares held */; avgPrice; entryCostUsdc;
  entryFeesUsdc; totalCostUsdc; currentPrice; currentValue; totalSize /* lifetime bought */; realizedPnl; unrealizedPnl;
  totalPnl; percentPnl; percentRealizedPnl /* all DecimalString */; status: 'OPEN'|'REDEEMABLE'|'CLOSED';
  redeemable: boolean; mergeable: boolean; negativeRisk: boolean; archived: boolean; title?; slug?; icon?; eventId?;
  eventSlug?; outcome?; outcomeIndex?: number; oppositeOutcome?; oppositeAssetId?; endDate?; ... };
type Activity = TradeActivity | SplitActivity | MergeActivity | RedeemActivity | ...;   // discriminate on `type`
//   base: { wallet; timestamp /* epoch ms */; transactionHash; name; pseudonym; ... }
//   TRADE: { type: 'TRADE'; isCombo; side: OrderSide; shares; amount; price; title; icon; conditionId; assetId; outcome; slug; eventSlug }
//   REDEEM: { type: 'REDEEM'; conditionId; amount; title; slug; icon; eventSlug }
type UserPnlSeries = { wallet; interval; fidelity; sourceFidelity; points: { timestamp; realizedPnl; unrealizedPnl|null; ... }[] };
```
Runtime: `listPositions({ user: '0x…01', pageSize: 2 }).firstPage()` → keys `items, hasMore, nextCursor`;
`fetchPortfolioValue({ user: '0x…01' })` → `{ wallet: '0x0000…0001', value: '10' }` **[V]**.

---

## 4. Not covered / unconfirmed

- No write path was executed: `createSecureClient`, order placement, cancel, redeem, transfer, approvals,
  `createBuilderApiKey`, `deployDepositWallet` are typed and tsc-checked only.
- V2 markets (`version: 'v2'`) were not available among top markets, so `positionId` as `assetId` is untested.
- Builder-key bootstrap order (2.3) is inferred.
- `search` `eventsStatus` accepted values unknown.
- `client.environment` works at runtime but is untyped; `production.contracts` likewise (cast needed).

Probe scripts: `scratchpad/dwspike/probe1.mjs` (client shape, env, enums), `probe2.mjs` (market data), `probe3.mjs`
(lookups, price-history params, pagination), `probe4.mjs` (pUSD metadata), `tc.ts` + `tsconfig.json` (type check).

---
name: polymarket
description: Developer and architecture reference for the Polymarket integration in Polygon Agent CLI. Covers the smart wallet direct signing architecture, on-chain approval model, CLOB auth, neg-risk markets, and SDK internals.
---

# Polymarket Integration — Developer Reference

## Architecture: Smart Wallet Direct Signing

The polygon-agent CLI uses the Sequence smart wallet as the direct Polymarket trading identity. No separate EOA or proxy wallet is required.

```
Sequence Smart Wallet (0x...)
  │  Holds USDC.e and outcome (CTF) tokens.
  │  Is the CLOB order maker and funder.
  │  Signs orders via the explicit session key (EIP-1271 compatible).
  │
  │  signatureType = POLY_GNOSIS_SAFE (EIP-1271)
  ▼
CLOB  — maker=smartWallet, signer=sessionKey, signatureType=POLY_GNOSIS_SAFE
```

### How Signing Works

The Sequence explicit session stores `pk` — an EOA private key authorized as a signer for the smart wallet. Orders are signed with this session key, but the smart wallet address is set as the order `maker`.

When the Polymarket CTF Exchange validates the order on-chain, it calls `isValidSignature(hash, sig)` on the smart wallet contract. The Sequence contract validates that the signer is an authorized session key.

```ts
// buildSequenceSignerForPolymarket (in lib/polymarket.ts)
const sessionAccount = privateKeyToAccount(explicitSession.pk);
const account = { ...sessionAccount, address: smartWalletAddress }; // override address
const walletClient = createWalletClient({ account, chain: polygon, transport: http() });
// → walletClient used as ClobSigner with SignatureType.POLY_GNOSIS_SAFE
```

### Address Summary

| Address | Role | Holds |
|---------|------|-------|
| Sequence Smart Wallet | CLOB order maker + funder | USDC.e + outcome tokens |
| Session Key (EOA) | Signs orders on behalf of smart wallet | Nothing (signs only) |

---

## On-Chain Approvals

Before trading, the smart wallet must grant token allowances to the exchange contracts. Set once, permanent.

Run: `polygon-agent polymarket approve --broadcast`

### Standard Markets (negRisk: false)

```
smart wallet grants:
  USDC.e.approve(CTF_EXCHANGE, MAX_UINT256)
  CTF.setApprovalForAll(CTF_EXCHANGE, true)
```

### Neg-Risk Markets (negRisk: true)

```
smart wallet grants:
  USDC.e.approve(NEG_RISK_ADAPTER, MAX_UINT256)
  USDC.e.approve(NEG_RISK_CTF_EXCHANGE, MAX_UINT256)
  CTF.setApprovalForAll(CTF_EXCHANGE, true)
  CTF.setApprovalForAll(NEG_RISK_CTF_EXCHANGE, true)
  CTF.setApprovalForAll(NEG_RISK_ADAPTER, true)
```

Approvals are executed via `runDappClientTx` through the Sequence relayer (paid in USDC.e).

---

## CLOB Authentication

Same two-layer auth as before, but now using the smart wallet WalletClient as the signer:

**L1 Auth (EIP-712)** — `createOrDeriveApiKey()` signs with the session key via the WalletClient. Derives a deterministic API keypair. Stateless — safe to call every session.

**L2 Auth (HMAC)** — HMAC-SHA256 over `timestamp + method + path + body` using the derived API secret.

**Important:** The smart wallet address must have accepted Polymarket's Terms of Service at polymarket.com at least once. Without this, `createOrDeriveApiKey()` returns `400 "Could not create api key"`.

### Order Signing: POLY_GNOSIS_SAFE

```
maker  = smartWalletAddress   (who commits funds and holds tokens)
signer = smartWalletAddress   (funderAddress in ClobClient constructor)
signatureType = POLY_GNOSIS_SAFE  (tells exchange to validate via isValidSignature)
```

The session key signs the EIP-712 payload. The Sequence contract validates on-chain.

---

## Gas Model

| Operation | Who pays | Token |
|-----------|----------|-------|
| `approve --broadcast` | Sequence relayer | USDC.e (fee abstraction) |
| `clob-buy --broadcast` | Off-chain CLOB | — (free, no fund transfer) |
| `sell --broadcast` | Off-chain CLOB | — (free) |

No POL required. No proxy wallet funding step. The smart wallet holds USDC.e and the Sequence relayer handles gas.

---

## Funding Flow

```
Smart Wallet (holds USDC.e)
        │
        │  CLOB BUY order (off-chain, POLY_GNOSIS_SAFE signature)
        ▼
Outcome tokens arrive in smart wallet
```

No intermediate transfer needed. The smart wallet IS the trading account.

---

## SDK Stack

| Package | Version | Used for |
|---------|---------|----------|
| `@polymarket/clob-client` | ^5.2.4 | CLOB API: order creation, posting, cancellation |
| `@polymarket/sdk` | ^6.0.1 | (retained for future use) |
| `@polymarket/order-utils` | ^3.0.1 | `SignatureType.POLY_GNOSIS_SAFE` enum |
| `viem` | project default | WalletClient for CLOB signing, `encodeFunctionData` |

`ethers5` dependency removed — no longer needed.

---

## Contracts (Polygon Mainnet, Chain 137)

| Contract | Address |
|----------|---------|
| USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| CTF (Conditional Token Framework) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| CTF Exchange | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` |
| Neg Risk CTF Exchange | `0xC5d563A36AE78145C45a50134d48A1215220f80a` |
| Neg Risk Adapter | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` |

---

## APIs

| API | Base URL | Auth |
|-----|----------|------|
| Gamma (market discovery) | `https://gamma-api.polymarket.com` | None |
| CLOB (trading) | `https://clob.polymarket.com` | EIP-712 L1 + HMAC L2 |
| Data (positions, trades) | `https://data-api.polymarket.com` | None |

Override via env: `POLYMARKET_GAMMA_URL`, `POLYMARKET_CLOB_URL`, `POLYMARKET_DATA_URL`.

---

## Neg-Risk Markets

Neg-risk markets use different exchange contracts. Detected via `negRisk: true` in Gamma API response.

Run `polygon-agent polymarket approve --neg-risk --broadcast` once to enable. Can be run on top of standard approvals — adds only the missing ones.

---

## Key Implementation Notes

- **`buildSequenceSignerForPolymarket`** (in `lib/polymarket.ts`) — loads explicit session, builds viem WalletClient with smart wallet address as account address and session key as signer.
- **`getClobClient`** always uses `SignatureType.POLY_GNOSIS_SAFE` (value 2). The smart wallet address is passed as `funderAddress` (6th arg to `ClobClient`).
- **`approve`** uses `runDappClientTx` — executes approval transactions through the Sequence relayer, no direct EOA gas required.
- **`positions`** queries `Data API` by smart wallet address — `getPositions(smartWalletAddress)`.
- **No `set-key` or `proxy-wallet` commands** — the wallet session is the only credential needed.
- **ToS acceptance**: The smart wallet address must accept Polymarket ToS at polymarket.com once. Use the smart wallet address (visible via `polygon-agent wallet list`).

---

## Agent Workflow

```bash
# 1. Accept ToS at polymarket.com using the smart wallet address
#    polygon-agent wallet list → note walletAddress, connect at polymarket.com

# 2. Set approvals (one-time)
polygon-agent polymarket approve --broadcast

# 3. Browse markets
polygon-agent polymarket markets --search "fed rate" --limit 5

# 4. Buy
polygon-agent polymarket clob-buy <conditionId> YES 10 --broadcast

# 5. Check positions
polygon-agent polymarket positions

# 6. Sell
polygon-agent polymarket sell <conditionId> YES <shares> --broadcast
```

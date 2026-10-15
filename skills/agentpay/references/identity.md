# Identity: ERC-8004 agent registration and reputation

**When to use:** the user wants to register the agent on-chain, look up an agent's identity or reputation, read reviews, or leave feedback. Polygon mainnet only.

**Before you start:** reads (`identity`, `reputation`, `reviews`) work from any install. Writes (`register`, `feedback`) need the wallet owner: an allowance install fails with `owner_required`. Tell the user, and don't look for a way around it. A developer can use owner mode ([developer](developer.md)).

## Commands

```sh
agent register --name <n> [--agent-uri <uri>] [--metadata <k=v,k=v>] [--broadcast|--dry-run]
agent identity --agent-id <id> [--key <metadata-key>]   # agent payment wallet + optional metadata
agent reputation --agent-id <id> [--tag1 <tag>] [--tag2 <tag>]
agent reviews --agent-id <id> [--tag1 <t>] [--tag2 <t>] [--include-revoked]
agent feedback --agent-id <id> --value <score> [--tag1 <t>] [--tag2 <t>] [--endpoint <e>] [--feedback-uri <uri>] [--broadcast|--dry-run]
```

**Contracts (Polygon mainnet):**

- IdentityRegistry: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
- ReputationRegistry: `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`

## Register

```sh
agent register --name "MyAgent" --broadcast
```

It mints an ERC-721 and emits a `Registered` event containing the `agentId`. To get the `agentId`, open the transaction on https://polygonscan.com, go to the Logs tab and find the `Registered` event: `agentId` is its first indexed parameter. Use it for `identity`, `reputation`, `reviews` and `feedback`.

## What to tell the user

| Command | How to present |
|---|---|
| `register` | The agent name and the transaction hash, with its Polygonscan link. Remind them where the `agentId` is (above). |
| `identity` | `agentId`, the wallet address, whether a wallet is set, and the decoded metadata value when `--key` was passed. |
| `reputation` | The score and tag breakdown as a small table. |

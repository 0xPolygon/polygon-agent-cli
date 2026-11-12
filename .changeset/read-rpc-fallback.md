---
'@polygonlabs/agent-cli': patch
---

Read-only chain calls work again without a project access key on Polygon, Amoy and Ethereum.

The public RPC hosts the CLI fell back to for those chains had stopped answering, so balance checks and transaction confirmations could fail before an access key was set up. All seven fallback chains (Polygon, Amoy, Ethereum, Base, Base Sepolia, Arbitrum, Optimism) now use PublicNode.

A chain with no fallback now fails with an error naming the chain and `SEQUENCE_PROJECT_ACCESS_KEY`, instead of quietly reading Polygon mainnet.

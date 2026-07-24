---
'@polygonlabs/agent-cli': minor
---

Add a persisted transaction mode and flatten the ERC-8004 command group.

- New `agent mode [auto|dry-run]`: `auto` makes write commands broadcast immediately; the default `dry-run` keeps the preview-first behavior. `--dry-run` on any write command forces a preview regardless of mode. `wallet login` asks once (interactive prompt on a TTY, `modePrompt` field in the JSON output otherwise).
- BREAKING: the `agent agent *` group is removed. Use top-level `register`, `identity` (replaces `agent agent wallet` + `agent agent metadata`), `reputation`, `reviews`, `feedback`. The hidden legacy aliases (`register`, `agent-wallet`, `agent-metadata`, `reputation`, `give-feedback`, `read-feedback`) and their interactive handlers are also removed.
- Fix: `reputation` and `reviews` no longer crash with "Cannot assign to read only property '0'" (frozen ethers Result passed back into a contract call), and `reputation` no longer fails to serialize a BigInt decimals field.

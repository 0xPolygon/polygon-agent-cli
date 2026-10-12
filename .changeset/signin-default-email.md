---
'@polygonlabs/agent-cli': patch
---

Session-mode sign-in now defaults to an emailed code. The browser is used only for an interactive terminal or a local coding agent (claude-code, cursor, codex) with no headless signal, and container detection also covers Podman, Kubernetes, and cgroup markers. Every connect and `wallet status` now return `dashboard.url`, the wallet's agentconnect page, and the CLI no longer opens the funding page on its own after a connect (`agent fund` still does).

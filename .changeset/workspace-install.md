---
'@polygonlabs/agent-cli': minor
---

Workspace installs: run the CLI from inside an assistant's workspace folder, with its own state.

- `POLYGON_AGENT_HOME` sets the state folder (default `~/.polygon-agent`). All state, including `config.json` and the token-directory cache, now lives under it.
- `workspace init --root <dir> [--skills-dir <dir>] [--name <name>]` does the setup, and is safe to re-run. It refuses a root that already holds other files. It writes:
  - a wrapper at `<root>/bin/polygon-agent`, which runs the CLI with `POLYGON_AGENT_HOME=<root>/state` and makes Node's `fetch` honor `HTTPS_PROXY`
  - a `.gitignore` containing `*`
  - `state/install.json`
  - the `polygon-oms-wallet` assistant skill, once a release bundles it
- `skills show <name>` and `skills install [name] --dir <dir>` print or write the skills now bundled in `dist/skills/`. When run through the wrapper, they render the wrapper's path into the skill. A `POLYGON_AGENT=` line is set to the single-quoted path, so nothing in it is expanded by the shell.
- `update` installs the latest CLI beside the current one, swaps it in, and re-runs `workspace init` from the new version. A failed install leaves the current CLI in place; a failed refresh rolls back. Concurrent updates of one workspace are serialized by a lock (`state/update.lock`). Outside a workspace install, it prints the global npm command.

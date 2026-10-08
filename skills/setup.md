---
name: polygon-oms-setup
description: >-
  One-time setup of the Polygon OMS Agent Kit: installs the polygon-agent CLI
  and the polygon-oms-wallet skill into the assistant's workspace, then connects
  the user's wallet with a spending allowance they approve by email code.
---

# Set up the Polygon OMS Agent Kit

**For the assistant.** Follow these steps in order. Each one is safe to re-run. Tell the user what you're doing in plain words as you go, and never paste raw JSON to them.

**What this sets up (tell the user in a sentence or two):** a Polygon OMS wallet that you, their assistant, can use within an allowance they approve by email code. You can check prices, watch them, buy, sell, swap and bridge tokens, and pay for x402 services. Anything beyond the allowance needs a new code from them. The wallet stays theirs. Each code signs the CLI in as them for a moment, just long enough to make that one change (approving an allowance, a withdrawal…), then signs out again. Only that limited key is kept, never their sign-in.

## 1. Find the workspace

Install into the folder your platform keeps across restarts:

| Assistant | Workspace | Skills folder |
|---|---|---|
| Muse | the VM's persistent workspace folder | the workspace's skills folder |
| OpenClaw | `~/.openclaw/workspace` | `~/.openclaw/workspace/skills` |
| Hermes | `~/.hermes` | `~/.hermes/skills` |
| Claude Code | `$HOME` | `~/.claude/skills` |
| Codex | `$HOME` | `~/.codex/skills` |
| Cursor | `$HOME` | `~/.cursor/skills` |
| A computer, anything else | `$HOME` | your platform's skills folder, if it has one |

If you're not sure which folder survives a restart, ask the user. Use absolute paths throughout (expand `~`). The install goes in `<workspace>/.polygon-agent`; below it's `$ROOT`:

```sh
ROOT='/absolute/path/to/workspace/.polygon-agent'
```

Keep the single quotes, so a path with spaces works (a `'` in the path itself is written `'\''`). Run each code block below as one command. Shell variables don't carry over between commands on every platform; if they don't on yours, start each block with this `ROOT=` line. The blocks that write files stop if `ROOT` isn't set, or still holds the example path.

## 2. Already installed?

```sh
"$ROOT/bin/polygon-agent" --version
```

If that prints a version, the CLI is installed: skip to step 5, which checks the skill too.

## 3. Node.js

```sh
node --version; npm --version
```

If Node is version 22 or newer and npm works, go to step 4. Otherwise install Node 24 (with npm) into the workspace, on Linux or macOS. This block stops at the first failure, including a checksum mismatch:

```sh
(
  set -e
  case "${ROOT:?Set ROOT to the install folder first}" in /absolute/path/*) echo "Set ROOT to the real install folder"; exit 1 ;; esac
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')                 # linux or darwin
  case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) ARCH=$(uname -m) ;; esac
  BASE=https://nodejs.org/dist/latest-v24.x
  cd "$(mktemp -d)"
  curl -fsSLO "$BASE/SHASUMS256.txt"
  FILE=$(grep -o "node-v[0-9.]*-$OS-$ARCH\.tar\.gz" SHASUMS256.txt | head -n 1)
  [ -n "$FILE" ] || { echo "No Node build for $OS-$ARCH"; exit 1; }
  curl -fsSLO "$BASE/$FILE"
  if command -v sha256sum >/dev/null; then
    grep " $FILE\$" SHASUMS256.txt | sha256sum -c -
  else
    grep " $FILE\$" SHASUMS256.txt | shasum -a 256 -c -
  fi
  mkdir -p "$ROOT/node"
  tar -xzf "$FILE" -C "$ROOT/node" --strip-components=1
  "$ROOT/node/bin/node" --version
)
```

If it fails, stop and tell the user why. From here on, run `npm` and `node` with `PATH="$ROOT/node/bin:$PATH"` in front, as in step 4 (harmless when Node came with the system). The CLI's wrapper finds this Node on its own.

## 4. Install

```sh
(
  set -e
  case "${ROOT:?Set ROOT to the install folder first}" in /absolute/path/*) echo "Set ROOT to the real install folder"; exit 1 ;; esac
  mkdir -p "$ROOT"
  PATH="$ROOT/node/bin:$PATH" npm install --ignore-scripts --prefix "$ROOT/cli" @polygonlabs/agent-cli@latest
  PATH="$ROOT/node/bin:$PATH" node "$ROOT/cli/node_modules/@polygonlabs/agent-cli/dist/index.js" \
    workspace init --root "$ROOT" --skills-dir "<skills folder>" --name "<install name>"
)
```

- `--ignore-scripts`: nothing the CLI needs runs an install script, and none should run beside the wallet's keys.
- `--skills-dir` is the skills folder from step 1. Leave it out if your platform has none.
- `--name` is what the wallet owner sees in their list of installs with access, like "OpenClaw on laptop". It defaults to the host name.
- `workspace init` writes the wrapper `$ROOT/bin/polygon-agent` (the only command you'll use from now on), the state folder and a `.gitignore`, so workspace backups never pick it up. It also installs the `polygon-oms-wallet` skill, already pointed at the wrapper.

Go on to step 5.

## 5. The skill

If you came here from step 2 (already installed), refresh the install first. This rewrites the wrapper and reinstalls the skill, using the folder and name recorded at install:

```sh
"$ROOT/bin/polygon-agent" workspace init --root "$ROOT"
```

Then:

- If the output of `workspace init` says `skill.installed: false` and your platform has a skills folder, run it again with `--skills-dir "<skills folder>"`. If its hint says this CLI version doesn't include the skill, run `"$ROOT/bin/polygon-agent" update` (it refreshes the install too).
- If there's still no skill installed, print it and save it with your platform's own skill tool: `"$ROOT/bin/polygon-agent" skills show polygon-oms-wallet`. Or use `npx skills add 0xPolygon/polygon-agent-cli -s polygon-oms-wallet -g -y -a <agent>`, where `<agent>` is `claude-code`, `codex`, `cursor`, `openclaw` or `hermes-agent`. That copy doesn't know the wrapper's path, so tell it: `$ROOT/bin/polygon-agent`.

- Read the skill now (`<skills folder>/polygon-oms-wallet/SKILL.md`, or the printed one), even if it was installed before. Follow its rules for the rest of this conversation, starting with the steps below.

## 6. Status

```sh
"$ROOT/bin/polygon-agent" wallet status
```

Check these in order:

1. `mode` is `"owner"`: this install is signed in with the browser login, as the wallet owner, with no allowance limits. Tell the user, and offer to switch to an allowance: `"$ROOT/bin/polygon-agent" wallet logout`, then step 7.
2. `pendingRequest` is there: a code was already sent to `pendingRequest.email` for what `pendingRequest.approves` says. Ask the user for that code and go to step 7.5. Don't send another unless it expired or they can't find it.
3. `connected` is `true`: skip to step 8.
4. Otherwise, connect (step 7).

## 7. Connect

Before asking for anything, explain how it works: the code lets the CLI sign in as the user for a moment, approve the allowance for this install's own limited key, and sign out. Only that key is kept.

1. Ask the user for their email. Never guess it.
2. Ask how much you may spend, explaining before anything is sent: "How much should I be able to spend on my own? I suggest up to **$1,000** over the next **30 days**, in USDC, USDT, ETH and BTC on Polygon and Base, for trades and paid services. Anything more, or other tokens or chains, needs a new code from you."
3. Send the code:

   ```sh
   "$ROOT/bin/polygon-agent" wallet login --email <email> --allowance <usd> --days <days>
   ```

   Add `--chains polygon,base,…` only if the user asked for different chains; chains where the wallet already holds supported tokens are added on their own. The output has `status: "code_sent"`, the `plan` (every chain, token and limit, with the expiry) and `next`.
4. Tell the user: "I've sent a code to <email>. Paste it here to approve: …", followed by a short summary of the plan from the output.
5. As soon as the user gives the code, run `next`:

   ```sh
   "$ROOT/bin/polygon-agent" wallet confirm --request <request> --code <code>
   ```

   Use the code only here, once. Never store it or repeat it. If it fails with `invalid_code`, ask for the code again. If it fails with `request_expired`, start again at step 7.3. On any other error, follow its `hint` and `command`.
6. Tell the user the result: their wallet address, the allowance and when it expires, and `worstCase` in plain words. Mention any chains in `failed` and any `warnings`.

## 8. Funding

Run `"$ROOT/bin/polygon-agent" wallet status` again. If it shows no `holdings`, run `"$ROOT/bin/polygon-agent" fund` and give the user the address and the link in `url`. Suggest USDC on Polygon; any covered token on a covered chain works.

## 9. Watches

Check whether your platform can run a recurring task (a Muse scheduled task, OpenClaw cron, a Hermes cronjob, cron on a computer). You don't need one yet. When the user creates their first price watch, the skill explains how to schedule its check. If you can't schedule, tell the user that watches only run while you're active.

## 10. Next steps

Tell the user what they can ask for now, in plain words. For example:

- "What's ETH at?" or "Tell me if BTC drops below $90k."
- "Buy $50 of ETH", or "Sell half my ETH if it goes over $4,000."
- "Move 20 USDC to Base."
- "Search the web with a paid service" (x402).

Re-run this file any time: if the wrapper is missing (the workspace was reset), it installs again; otherwise it refreshes the skill, checks the connection and moves on.

---
name: polygon-oms-setup
description: >-
  One-time setup of the Polygon Agent Wallet: installs the polygon-agent CLI
  and the polygon-agent-wallet skill into the assistant's workspace, then connects
  the user's wallet with a spending allowance they approve by signing in.
---

# Set up the Polygon Agent Wallet

**For the assistant.** Follow these steps in order. Each one is safe to re-run. Whenever you hand the conversation back to the user, end with a question or with exactly what they should do next. Never stop on a status report.

**How to talk to the user.** Talk like a helpful assistant: short, friendly, outcome first, one or two sentences. Don't narrate how things work (sign-in mechanics, session keys, the background sign-in, the Polymarket key backup or the extra wallet it adds, JSON fields or status names) unless the user asks or something fails. Never paste raw JSON. Install steps need no running commentary: say what you're setting up once, and speak up again only when you need something from them.

**What this sets up.** Tell the user in one sentence, for example: "I'll set up an agent wallet I can spend from within a limit you approve. It stays yours." For you, if they ask: you can check and watch prices, buy, sell, swap and bridge tokens, bet on Polymarket, and pay for x402 services. Anything beyond the allowance needs a new sign-in from them. Each sign-in signs the CLI in as them just long enough to make that one change, then signs out; only this install's limited key is kept, never their sign-in.

## 1. Find the workspace

Install into the folder your platform keeps across restarts:

| Assistant | Workspace | Skills folder |
|---|---|---|
| Muse | the VM's persistent workspace folder | the workspace's skills folder |
| OpenClaw | `~/.openclaw/workspace` | `~/.openclaw/workspace/skills` |
| Hermes | `$HERMES_HOME` (`~/.hermes` if it's not set) | `$HERMES_HOME/skills` |
| Claude Code | `$HOME` | `~/.claude/skills` |
| Codex | `$HOME` | `~/.codex/skills` |
| Cursor | `$HOME` | `~/.cursor/skills` |
| A computer, anything else | `$HOME` | your platform's skills folder, if it has one |

If you're not sure which folder survives a restart, ask the user. Use absolute paths throughout (expand `~` and variables like `$HERMES_HOME`). The install goes in `<workspace>/.polygon-agent`; below it's `$ROOT`:

```sh
export ROOT='/absolute/path/to/workspace/.polygon-agent'
```

Keep the single quotes, so a path with spaces works (a `'` in the path itself is written `'\''`). Run each code block below as one command. Some platforms keep exported variables from one command to the next and some don't; if `ROOT` is empty in a later step, start each block with this `export ROOT=` line. The blocks that write files stop if `ROOT` isn't set, or still holds the example path. Steps 3 and 4 download and install, which can take a few minutes: if your platform limits how long a command may run, allow up to 10 minutes for them.

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
    workspace init --root "$ROOT" --skills-dir "<skills folder>" --name "<install name>" --platform "<platform>"
)
```

- `--ignore-scripts`: nothing the CLI needs runs an install script, and none should run beside the wallet's keys.
- `--skills-dir` is the skills folder from step 1. Leave it out if your platform has none.
- `--name` is what the wallet owner sees in their list of installs with access, like "OpenClaw on laptop". It defaults to the host name. Reuse the same name when you reinstall, because the Polymarket key backup is labelled with it, and recovery finds the key by that label.
- `--platform` is your own platform: `muse`, `openclaw`, `hermes`, `claude-code`, `cursor`, `codex` or `other`. Pass the one you are; a platform not listed passes `other`. The CLI uses it to pick the sign-in method. An emailed code is the default. The browser is used only for a local coding agent (`claude-code`, `cursor`, `codex`) on a desktop, or a person typing in a terminal.
- `workspace init` writes the wrapper `$ROOT/bin/polygon-agent` (the only command you'll use from now on), the state folder and a `.gitignore`, so workspace backups never pick it up. It also installs the `polygon-agent-wallet` skill, already pointed at the wrapper.

Go on to step 5.

## 5. The skill

If you came here from step 2 (already installed), refresh the install first. This rewrites the wrapper and reinstalls the skill, using the folder and name recorded at install:

```sh
"$ROOT/bin/polygon-agent" workspace init --root "$ROOT"
```

Then:

- If the output of `workspace init` says `skill.installed: false` and your platform has a skills folder, run it again with `--skills-dir "<skills folder>"`. If its hint says this CLI version doesn't include the skill, run `"$ROOT/bin/polygon-agent" update` (it refreshes the install too).
- If there's still no skill installed, print it and save it with your platform's own skill tool: `"$ROOT/bin/polygon-agent" skills show polygon-agent-wallet`. Or use `npx skills add 0xPolygon/polygon-agent-cli -s polygon-agent-wallet -g -y --copy -a <agent>`, where `<agent>` is `claude-code`, `codex`, `cursor`, `openclaw` or `hermes-agent`. That copy doesn't know the wrapper's path, so tell it: `$ROOT/bin/polygon-agent`.

- Read the skill now (`<skills folder>/polygon-agent-wallet/SKILL.md`, or the printed one), even if it was installed before. Follow its rules for the rest of this conversation, starting with the steps below.

## 6. Status

```sh
"$ROOT/bin/polygon-agent" wallet status
```

Check these in order:

1. `mode` is `"owner"`: this install has full owner access, with no spending limit. Tell the user briefly and offer to switch to a limit: `"$ROOT/bin/polygon-agent" wallet logout`, then step 7.
2. `pendingRequest` is there. If its `method` is `browser`, a sign-in page is waiting at `pendingRequest.url` for what `pendingRequest.approves` says: ask the user to finish it there, then run `pendingRequest.next`. Otherwise a code was already sent to `pendingRequest.email`: ask the user for it and run `pendingRequest.next` with it. Don't start another unless it expired.
3. `connected` is `true`: skip to step 8.
4. Otherwise, go straight on to step 7 in the same reply.

## 7. Connect

Don't leave the user with a status report after the install. Say it worked, explain signing in a sentence or two, and ask. For example: "Your agent wallet is installed. Next, sign in so I can use it: signing in approves a spending limit for me, nothing more, and your sign-in itself is never kept here. Would you like to sign in now?" If they'd rather wait, tell them to just say "sign in to my agent wallet" when they're ready.

1. Once they say yes, ask how much you may spend, for example: "How much should I be able to spend on my own? I suggest up to **$1,000** over the next **30 days**."
2. Start the connection. Don't ask for an email yet: the CLI picks the method (a browser page, or a code sent by email) and tells you what it needs.

   ```sh
   "$ROOT/bin/polygon-agent" wallet login --allowance <usd> --days <days>
   ```

   Add `--chains polygon,base,…` only if the user asked for different chains; chains where the wallet already holds supported tokens are added on their own. Then handle the outcome:

   - `status: "waiting"`: the user signs in on a page. Tell them, for example, "Sign in on the page that just opened to approve $1,000 over 30 days." (amount and period from the `plan`). If this machine has no browser, or they say nothing opened, send them the `url`. Then run `next` (it ends in `--wait`). It blocks for up to about 90 seconds. If it returns `waiting` again, run `next` again, until it finishes. If the user cancels on the page it fails with `request_cancelled`: ask whether to try again.
   - `email_required` (an error): ask the user for their email. Never guess it. Then run its `command`, with the email in place of `<email>`.
   - `status: "code_sent"`: tell the user, for example, "I've sent a code to <email>. Paste it here to approve $1,000 over 30 days." (amount and period from the `plan`). As soon as they give the code, run `next`:

     ```sh
     "$ROOT/bin/polygon-agent" wallet confirm --request <request> --code <code>
     ```

     Use the code only here, once. Never store it or repeat it. If it fails with `invalid_code`, ask for the code again. If it fails with `request_expired`, start again at step 2. On any other error, follow its `hint` and `command`.
3. Two more errors. `browser_signin_failed` means the page sign-in stopped: run its `command` to sign in with an emailed code instead. `request_in_progress` means a sign-in for this wallet is already finishing: run its `--wait` command.
4. Tell the user the result in one short line, for example: "You're connected. I can spend up to $1,000 over the next 30 days." Take the amount and period from `allowance` in the output. If anything is in `failed` or there are `warnings`, say briefly that part of the setup needs a retry, without naming chains, and run the hinted command. Talk about the allowance as a dollar amount and period only. Don't mention chains or tokens.
5. Give the address: end your message with "Your agent wallet address is:" and send the full address as the next message, with nothing else in it, so the user can copy it in one go. Never shorten it. (If your platform sends only one message per reply, put it alone on its own line.)
6. Then send: "You can see your wallet and add funds here: <dashboard.url>", with `dashboard.url` from the output, sent in full. Nothing opens on its own, so always send the link. `wallet status` returns the same `dashboard.url` whenever you need it again.

## 8. Funding

Run `"$ROOT/bin/polygon-agent" wallet status` again. If it shows no `holdings` and you haven't already sent the link, send `dashboard.url` from its output (the address is already in its own message from step 7). Whenever any command's output has `funding`, send its `url` with a few words on what it's for. If they ask what to send, suggest USDC on Polygon.

## 9. Watches

Check whether your platform can run a recurring task (a Muse scheduled task, OpenClaw cron, a Hermes cron job, cron on a computer). You don't need one yet, and there's nothing to tell the user now. Hermes cron jobs only run while the Hermes gateway is running (`hermes gateway start`); if it isn't, tell the user. When the user creates their first price watch, the skill explains how to schedule its check, and what to say if you can't.

## 10. Next steps

In a sentence or two, tell the user what they can ask for now, with two or three examples such as:

- "What's ETH at?" or "Tell me if BTC drops below $90k."
- "Buy 10 POL", "Buy $50 of ETH", or "Sell half my ETH if it goes over $4,000."
- "Move 20 USDC to Base."
- "What are the odds on <event>?" or "Put $5 on <something> on Polymarket."
- "Search the web with a paid service" (x402).
- "Raise my limit to $2,000" (a new sign-in approves it).

Re-run this file any time: if the wrapper is missing (the workspace was reset), it installs again; otherwise it refreshes the skill, checks the connection and moves on.

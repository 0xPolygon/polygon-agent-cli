# Install

**When to use:** AgentPay isn't installed here yet (`POLYGON_AGENT` still says `<workspace>`, or `--version` fails), or the workspace was reset. Each step is safe to re-run. Once installed, go back to the spine's step 2 (status) and on to [connect](connect.md).

**Talking to the user:** no running commentary. Say once what you're setting up, then speak up only when you need something from them or something fails.

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
| Grok Bot | `$HOME`, or the folder it keeps across restarts | its skills folder, if it has one |
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

## 4. Install the CLI and the skill

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
- `--platform` is your own platform: `muse`, `openclaw`, `hermes`, `grok`, `claude-code`, `cursor`, `codex` or `other`. Pass the one you are; a platform not listed passes `other`. The CLI uses it to pick the sign-in method (see [platforms](platforms.md)).
- `workspace init` writes the wrapper `$ROOT/bin/polygon-agent` (the only command you'll use from now on), the state folder and a `.gitignore`, so workspace backups never pick it up. It also installs the `agentpay` skill with its references, already pointed at the wrapper.

## 5. The skill

If you came here from step 2 (already installed), refresh the install first. This rewrites the wrapper and reinstalls the skill, using the folder and name recorded at install:

```sh
"$ROOT/bin/polygon-agent" workspace init --root "$ROOT"
```

Then:

- If the output of `workspace init` says `skill.installed: false` and your platform has a skills folder, run it again with `--skills-dir "<skills folder>"`. If its hint says this CLI version doesn't include the skill, run `"$ROOT/bin/polygon-agent" update` (it refreshes the install too).
- If there's still no skill installed, print it and save it with your platform's own skill tool: `"$ROOT/bin/polygon-agent" skills show agentpay`. Its references print the same way (`skills show connect`, `skills show polymarket`, …). Or use `npx skills add 0xPolygon/polygon-agent-cli -s agentpay -g -y --copy -a <agent>`, where `<agent>` is `claude-code`, `codex`, `cursor`, `openclaw` or `hermes-agent`. That copy doesn't know the wrapper's path, so tell it: `$ROOT/bin/polygon-agent`.
- Read the installed skill now (`<skills folder>/agentpay/SKILL.md`, or the printed one), even if it was installed before. It matches this CLI's version: follow it for the rest of this conversation, from its step 2 (status). After the install, go straight on to signing in in the same reply ([connect](connect.md)).

Re-run this any time: if the wrapper is missing (the workspace was reset), it installs again; otherwise it refreshes the skill and moves on.

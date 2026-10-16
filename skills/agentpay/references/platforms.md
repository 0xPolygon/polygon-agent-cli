# Platforms

**When to use:** you need your assistant's specifics: where to install, how sign-in reaches the user, or how to run a recurring task. The install steps themselves are in [install](install.md).

## Workspace and skills folder

| Assistant | Workspace | Skills folder | `--platform` |
|---|---|---|---|
| Muse | the VM's persistent workspace folder | the workspace's skills folder | `muse` |
| OpenClaw | `~/.openclaw/workspace` | `~/.openclaw/workspace/skills` | `openclaw` |
| Hermes | `$HERMES_HOME` (`~/.hermes` if it's not set) | `$HERMES_HOME/skills` | `hermes` |
| Claude Code | `$HOME` | `~/.claude/skills` | `claude-code` |
| Codex | `$HOME` | `~/.codex/skills` | `codex` |
| Cursor | `$HOME` | `~/.cursor/skills` | `cursor` |
| Grok Bot | `$HOME`, or the folder it keeps across restarts | its skills folder, if it has one | `grok` |
| A computer, anything else | `$HOME`, or the folder your platform keeps across restarts | your platform's skills folder, if it has one | `other` |

If you're not sure which folder survives a restart, ask the user.

## How sign-in reaches the user

The CLI picks the method; you don't. First match wins:

1. `POLYGON_AGENT_SIGNIN=browser` or `email` forces one.
2. A chat platform (`muse`, `openclaw`, `hermes`, `grok`, from `workspace init --platform`) gets an emailed code. So does CI, an SSH session, a container, or Linux with no display.
3. An interactive terminal, or a local coding agent (`claude-code`, `cursor`, `codex`; with no recorded platform, `CLAUDECODE=1` counts as `claude-code`) on a desktop, gets a browser page.
4. Anything else gets an emailed code.

## Recurring tasks (for watches)

| Assistant | Scheduler | Notes |
|---|---|---|
| Muse | a scheduled task | |
| OpenClaw | OpenClaw cron | |
| Hermes | a Hermes cron job | Only runs while the Hermes gateway is running (`hermes gateway start`). If it isn't, tell the user. The job should load this skill. |
| A computer | cron | cron's `PATH` is minimal: put Node's folder in the line (from `command -v node`, resolved when you write it). Alerts then reach the user only through `wallet status`. |
| No scheduler | none | Tell the user that watches only run while you're active (`watch run` checks in the foreground until stopped). |

## Messages

Some platforms send one message per reply. Where this skill says to send something "as a message of its own" (the wallet address), put it alone on its own line instead.

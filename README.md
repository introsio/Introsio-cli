# introsio — connect any coding agent to Introsio

One command connects your coding agents to Introsio, gives them a
`/introsio-execute` command for running a Developer Mode project, and installs
hooks that keep Introsio in step with what the agent actually did.

```bash
npx introsio setup                 # once published
node agent-kit/cli.mjs setup       # from a clone of this repository
```

`setup` finds the agents on this computer, or takes `--agents claude,codex,…`. It
installs **globally**, so it works in every repository you open, and copies the
hook engine to `~/.introsio/kit`, so the hooks never depend on this checkout.

| Agent | Connect (MCP) | `/introsio-execute` | Hooks |
|---|---|---|---|
| Claude Code | `claude mcp add` (user scope) | `~/.claude/commands/` | blocking |
| Codex | `~/.codex/config.toml` | `/prompts:introsio-execute` | blocking |
| Gemini CLI | `~/.gemini/settings.json` | `~/.gemini/commands/` | blocking |
| Cursor | `~/.cursor/mcp.json` | `~/.cursor/commands/` | blocking (stop-hook reliability varies by Cursor version) |
| OpenCode | `opencode.json` | `commands/` | blocking (a plugin) |
| VS Code (Copilot) | user `mcp.json` | prompt file | none |
| Windsurf | `mcp_config.json` | `introsio print-execute` → paste as a rule | none |

**Signing in.** No key is stored anywhere. Each agent signs in through its own MCP
OAuth flow (Introsio supports dynamic client registration and PKCE). `setup` tells
you the exact step for each agent, for example `/mcp` in Claude Code or
`codex mcp login introsio`.

## How it works

The agent runs a project with the server's loop: `claimTask` → work → `completeTask`
with an outcome (ADR-0008). The hooks never call Introsio themselves; they have no
credential. They watch the agent's own Introsio calls and make sure it finishes
the loop.

- **After each Introsio call**, the hook records what the session holds: a
  successful `claimTask` opens a task, a successful `completeTask` (or `updateTask`
  to blocked/pending) closes it, and a refused call changes nothing. State lives
  in `~/.introsio/sessions/<session>.json`, one file per session, so parallel
  agents never collide.
- **When the agent tries to stop** with a task still open, it is sent back with the
  exact call to make. If it tries twice without changing anything, it is let go
  with a warning rather than looping. Agents whose hooks don't see MCP calls
  instead have the open set rebuilt from the transcript.
- A hook costs **no tokens** unless it prints. The engine decides in under a
  millisecond; one hook process, including Node start-up, takes about 50 ms.
  `INTROSIO_HOOKS=off` turns every hook off for a session.

The hooks also include the following checks. Each one can be switched off
(`introsio disable <name>`).

| Feature | What it does |
|---|---|
| `stop-guard` | No finishing while a claimed task is open |
| `test-gate` | `completeTask` waits for the repo's check command (`introsio gate set "npm test"`). Passes are cached per work tree, and a failure sends the last 40 lines back |
| `shipped-gate` | **local** mode: work must be committed. **github** mode: committed, pushed, off the default branch, `outcome.branch` recorded |
| `push-guard` | No push to the default branch, no force push, no mirror; in local mode, no push at all |
| `secrets` | Commits and pushes adding keys, private keys or `.env` files are refused, naming the file:line, never the value |
| `scope` | One soft note per file edited outside the files the task names |
| `worker-id` | Refuses a claim with another live session's workerId, and a second claim without one |
| `compact-recovery` | After context compaction: the task, workerId, subtask progress and context revision |
| `lease` | One reminder when a claim is 60% through its lease with no progress reported |
| `reread` | Refuses once a context read the agent already has, or a schedule read straight after `nowReady` |
| `log` | `~/.introsio/log.jsonl`, summed up by `introsio stats` |

The gates and git guards only act in sessions that have used Introsio, and only
on tasks that session claimed. Completing a personal task, or pushing in a repo
that has nothing to do with Introsio, is never touched.

### Modes: keep the code on this computer, or ship it to GitHub

| Mode | Before a task can be Done | `git push` |
|---|---|---|
| `github` (auto when the Introsio project is linked to a GitHub repository) | committed, pushed on its own branch, `outcome.branch` recorded | allowed, except to the default branch or forced |
| `local` (auto otherwise) | committed | blocked |
| `off` | no check | no check |

Set a mode per repository with `introsio mode local`, `introsio mode github`,
`introsio mode off` or `introsio mode auto`.

## Commands

```
introsio setup [--agents a,b] [--project <repo>] [--url <mcp url>] [--dry-run]
introsio uninstall [--agents a,b] [--project <repo>]
introsio status | doctor
introsio mode github|local|off|auto
introsio gate set "<cmd>" [--timeout <sec>] | gate off | gate run | gate
introsio features | enable <name> | disable <name>
introsio claims | claims clear
introsio stats [--since 7d] [--project <id>] [--json]
introsio print-execute
```

- `--project <repo>` installs into one repository instead (committed, so a team
  shares it). The kit is copied to `<repo>/.introsio/kit` and the configs use
  repo-relative paths.
- `--url` points the agents at another MCP server, such as a local backend; it is
  remembered.
- A config file with comments is never rewritten. `setup` prints what to add to it.
- `uninstall` removes only what `setup` added.

## Layout

- `cli.mjs` — the `introsio` command
- `agents/<agent>.mjs` — one adapter per agent: detect, connect, command, hooks, uninstall, status
- `hook/introsio-hook.mjs` → `normalize.mjs` (each agent's payload into one shape) → `engine.mjs` (the decisions) → `respond.mjs` (each agent's output format)
- `hook/features/*.mjs` — one pure module per feature
- `opencode/introsio.template.js` — the OpenCode plugin (it imports the same engine)
- `templates/execute.md` — the `/introsio-execute` procedure, rendered into each agent's command format

Tests: `npm run test:agent-kit` from the repo root. They use plain
`node:assert/strict`, a scratch HOME and real git repositories.

Hook formats follow each agent's documentation as of October 2026. Agents change
these often: run `introsio doctor` after updating an agent.

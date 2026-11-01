# int — connect any coding agent to Introsio

One command connects your coding agents to Introsio, gives them a
`/introsio-execute` command for running a Developer Mode project, and installs
hooks that keep Introsio in step with what the agent actually did.

## Install

Needs Node 18 or newer and one or more coding agents.

```bash
npx introsio setup            # try it once, nothing stays installed
```

```bash
npm install -g introsio       # keeps the `int` command (`introsio` works too)
```

```bash
int setup                     # connect your agents, once per computer
```

From a clone of this repository, before the package is published:

```bash
node agent-kit/cli.mjs setup
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
| Windsurf | `mcp_config.json` | `int print-execute` → paste as a rule | none |

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
- **When the agent tries to stop** with a task still open, it is sent back once,
  with the exact call to make — and told to follow what the user asked first: if
  the user only wanted the task claimed or asked to pause, it releases it instead
  of doing the work. Stopping again with the same tasks open is taken as a
  decision: it is let go with a visible warning and not asked again. Agents whose
  hooks don't see MCP calls have the open set rebuilt from the transcript, read
  incrementally.
- A hook costs **no tokens** unless it prints. The engine decides in under a
  millisecond; one hook process, including Node start-up, takes about 50 ms.
  `INTROSIO_HOOKS=off` turns every hook off for a session.

The hooks also include the following checks. Each one can be switched off
(`int disable <name>`).

| Feature | What it does |
|---|---|
| `stop-guard` | No finishing while a claimed task is open |
| `test-gate` | `completeTask` waits for the repo's check command (`int gate set "npm test"`). Passes are cached per work tree, and a failure sends the last 40 lines back |
| `shipped-gate` | **local** mode: work must be committed. **github** mode: committed, pushed, off the default branch, `outcome.branch` recorded |
| `push-guard` | No push to the default branch, no force push, no mirror; in local mode, no push at all |
| `secrets` | Commits and pushes adding keys, private keys or `.env` files are refused, naming the file:line, never the value |
| `scope` | One soft note per file edited outside the files the task names |
| `worker-id` | Refuses a claim with another live session's workerId, and a second claim without one |
| `compact-recovery` | After context compaction: the task, workerId, subtask progress and context revision |
| `lease` | One reminder when a claim is 60% through its lease with no progress reported |
| `reread` | Refuses once a context read the agent already has, or a schedule read straight after `nowReady` |
| `log` | `~/.introsio/log.jsonl`, summed up by `int stats` |

The gates and git guards only act in sessions that have used Introsio, and only
on tasks that session claimed. Completing a personal task, or pushing in a repo
that has nothing to do with Introsio, is never touched.

### Modes: keep the code on this computer, or ship it to GitHub

| Mode | Before a task can be Done | `git push` |
|---|---|---|
| `github` (auto when the Introsio project is linked to a GitHub repository) | committed, pushed on its own branch, `outcome.branch` recorded | allowed, except to the default branch or forced |
| `local` (auto otherwise) | committed | blocked |
| `off` | no check | no check |

Set a mode per repository with `int mode local`, `int mode github`,
`int mode off` or `int mode auto`.

## Edge cases (researched, reproduced, fixed)

Each of these was first reproduced against the earlier kit, then fixed, and is kept
as a regression test in `test/edgecases.test.js` (same numbers).

| # | What broke | What the kit does now |
|---|---|---|
| R1 | Agents run the hooks of parallel tool calls at the same time; concurrent writes lost claims (10 of 12 kept) | Every session update runs under a per-session lock (`lib/lock.mjs`, stale locks taken over after 10 s, fail-open after 4 s) |
| R2 | A timed-out test gate left its child processes (test workers) running | The gate runs in its own process group; on timeout, on exit, or if the agent kills the hook, the whole group is killed (`lib/processTree.mjs`) |
| R3 | A diff over 16 MB made the gate cache blind to changes, so stale passes were reused | The cache key is the `git stash create` tree id plus every untracked file's size/mtime; an unreadable tree is never cached |
| R4 | A bare `git push` from a branch whose upstream is main went through | A bare push is checked against `@{push}` (honours `push.default`) |
| R5 | The person's own uncommitted files blocked the agent's completion forever | Only the task's files are checked (edited this session ∪ `outcome.files`); with none known, the refusal says to list them |
| R6 | A Claude subagent's stop was blocked by its parent's claim | `SubagentStop` is not hooked |
| R7 | A claim on a deleted task re-blocked every later stop | A 404 drops the claim; a set that was let go never re-blocks |
| R8 | Payloads without a session id all shared one "unknown" session | The agent process id becomes the session key |
| R9 | A crashed session's workerId was refused after a restart | A clash counts only if the other agent process is alive (or, without a pid, heard from in the last 10 min) |
| R10 | A failing gate printing one huge line flooded the context | Output tail: 40 lines × 300 chars, 3000 in all; every message at most 6000 chars |
| R11 | AWS's documented example key (in tests everywhere) blocked commits | Lines with `EXAMPLE`, `int:allow-secret`, `pragma: allowlist secret`, `gitleaks:allow` or `nosec` are skipped |
| R12 | GUI apps (Cursor, VS Code) start without the shell's PATH, so `node` (nvm, fnm, Homebrew) wasn't found | Global hooks name the absolute Node that ran `int setup`; `int doctor` warns when it disappears |
| R13 | Windows paths were written with doubled backslashes | Paths in commands use forward slashes |
| R14 | A gate timeout above the agents' 900 s hook timeout was accepted, so the agent cut the hook off and the completion went through unchecked | At most 840 s, enforced by the CLI and the engine |
| R15 | Codex Stop got empty stdout where Codex expects JSON | Codex always gets JSON (`{}` when there's nothing to say) |
| R16 | A task another worker took over still held this session | A 409 naming another worker drops the claim and tells the agent |
| R17 | The guard made the agent do work the user had said not to do (found in a real Claude Code run) | The message puts the user's instruction first and offers release (`statusState: "pending"`); one reminder only |
| R18 | An agent that keeps stdin open hung the hook | The payload is read until it parses (2 s idle, 10 s cap) |
| R19 | A long Codex transcript was re-parsed on every stop (85 MB: ~300 ms each) | Read incrementally from a saved offset (~50 ms after the first) |
| R20 | The re-read guard refused context to a subagent that never had it | The refusal says to call again; the second identical call goes through |
| R21 | A parallel worker without a workerId was told to reuse its parent's | It is told to pick its own (`<id>-2`) |
| R22 | A hand-broken settings file was silently replaced by the next command | Commands refuse to write a settings file they cannot read; hooks keep running on defaults |
| R23 | Internal hook errors vanished | They go to `~/.introsio/errors.log` (1 MB, rotated); `int doctor` shows recent ones; the agent still gets valid output |
| R24 | On Windows, git (`C:/…`), Node (`C:\…`) and temp folders (`MAHESH~1`) spell one folder three ways, so `int mode` / `int gate` settings were never found by the hooks and edited files looked "outside" the repo (found on the first Windows run) | One canonical spelling (`canonicalPath` / `repoKey` in `lib/paths.mjs`, case-insensitive on Windows) for every settings key and file comparison; CI now runs on Windows, macOS and Linux |

Tested end to end with Claude Code 2.1.312 (headless `claude -p`, a stub Introsio
MCP server over stdio, the installed hooks):
- a claim is recorded from Claude's real payload, and the stop is refused until `completeTask`;
- "only claim it" leaves the work undone, and the agent stops after one reminder;
- a failing gate refuses the first `completeTask` in PreToolUse; the agent reads the
  failure, fixes it, commits locally (local mode: no push) and completes.

## Commands

```
int setup [--agents a,b] [--project <repo>] [--url <mcp url>] [--dry-run]
int uninstall [--agents a,b] [--project <repo>]
int status | doctor
int mode github|local|off|auto
int gate set "<cmd>" [--timeout <sec>] | gate off | gate run | gate
int features | enable <name> | disable <name>
int claims | claims clear
int stats [--since 7d] [--project <id>] [--json]
int print-execute
```

- `--project <repo>` installs into one repository instead (committed, so a team
  shares it). The kit is copied to `<repo>/.introsio/kit` and the configs use
  repo-relative paths.
- `--url` points the agents at another MCP server, such as a local backend; it is
  remembered.
- A config file with comments is never rewritten. `setup` prints what to add to it.
- `uninstall` removes only what `setup` added.

## Layout

- `cli.mjs` — the `int` command
- `agents/<agent>.mjs` — one adapter per agent: detect, connect, command, hooks, uninstall, status
- `hook/introsio-hook.mjs` → `normalize.mjs` (each agent's payload into one shape) → `engine.mjs` (the decisions) → `respond.mjs` (each agent's output format)
- `hook/features/*.mjs` — one pure module per feature
- `opencode/introsio.template.js` — the OpenCode plugin (it imports the same engine)
- `templates/execute.md` — the `/introsio-execute` procedure, rendered into each agent's command format

Tests: `npm run test:agent-kit` from the repo root. They use plain
`node:assert/strict`, a scratch HOME and real git repositories.

Hook formats follow each agent's documentation as of October 2026. Agents change
these often: run `int doctor` after updating an agent.

## Publishing a release (maintainers)

The package is `introsio` on npm (commands `int` and `introsio`).

1. Bump `version` in `package.json` (`int doctor` tells users on older hooks to re-run `int setup`), and merge.
2. Add the repository secret `NPM_TOKEN` once (an npm Automation token that may publish `introsio`).
3. Tag the release; `.github/workflows/agent-kit-release.yml` runs the tests, checks the tag against the version, and publishes with provenance:

```bash
git tag agent-kit-v0.2.0 && git push origin agent-kit-v0.2.0
```

To publish by hand instead: `npm login`, then `npm publish` from this folder (the tests run first via `prepublishOnly`).

## License

[MIT](./LICENSE) © 2026 Introsio. This license covers the `int` CLI in
`agent-kit/` only; the Introsio service it connects to is a separate product.

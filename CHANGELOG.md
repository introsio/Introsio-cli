# Changelog

All notable changes to `introsio` (the `int` CLI) are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/) and the
project uses [semantic versioning](https://semver.org/).

## [Unreleased]

## [0.4.0]

Parallel agents on one project. Run `int setup` again after updating: the
installed hook engine is versioned, and `int doctor` reports one that is behind.
New hook features are on by default; `int disable shared-tree | inputs | wait`
turns one off.

### Added
- Parallel agents (README "Parallel agents"):
  - `int worktree add <name>` / `list` / `remove`: one folder (git worktree) per
    agent, on branch `agent/<name>`; `list` shows which agent works where, and
    `remove` refuses while a live agent holds a task there or files are uncommitted.
  - `shared-tree` hook: a claim in a folder another live agent session is working
    in is refused once, naming `int worktree add`.
  - `inputs` hook: after a claim, the dependency branches the task's starting point
    lacks, with the merge command.
  - `wait` hook and `int wait <retryAfter>`: when other workers hold all the ready
    work, the agent waits (at most 4 minutes per call) and claims again instead of
    stopping; one stop is sent back.
- `/introsio-execute` merges the branches of the tasks a task builds on before it
  starts, records `outcome.branch` in local mode too, waits on `all_claimed` /
  `awaiting_completion`, and describes the final integration task.

### Changed
- `int mode` / `int gate` are repository-wide: set inside a linked worktree they
  apply to the main checkout and every worktree, and `int gate run` runs in the
  worktree you are in.

## [0.3.0]

Run `int setup` again after updating: the installed hook engine is versioned, and
`int doctor` reports one that is behind.

### Added
- `--toolset execute` for `int setup`: the slim set of 13 tools for running a plan
  that already exists (the claim → complete loop, pause / resume and the hand-off),
  about a third of the tool definitions an agent otherwise carries on every turn.
  `developer` stays the default; the choice is remembered.
- Lost claims: when a project reset revokes a task the session holds
  (`CLAIM_REVOKED_BY_RESET`), the hook drops the claim and tells the agent why, so
  the stop-guard no longer holds it to work that can no longer be finished.
- Daily MCP budgets: when a budget is used up (`PLAN_LIMIT_REACHED`), the agent is
  told when it resets and to pause what it holds. A refused `claimTask` leaves no
  claim, so the agent may stop.
- The command procedures name finished steps in `completeTask` / `pauseTask`
  (`completedSubtasks`) instead of one call per step, size the outcome to the task,
  and skip chat recaps between tasks.

### Changed
- The push guard refuses `git push --all` and `--branches` in github mode (they
  push the default branch too); `--tags` still passes.
- `bash -c` / `sh -c` / `eval` scripts are checked like the bare command, behind
  `env` / `sudo` prefixes and nested up to 3 levels, for both the push guard and the
  secrets check.

### Fixed
- Claims lost when an agent ran the hooks of parallel tool calls at the same time:
  per-session locks now take over abandoned locks safely, a waiter saves only its own
  changes merged into what is on disk, and atomic writes retry the rename Windows
  refuses while a file is open.

## [0.2.0]

Never published on its own; everything in it ships in 0.3.0.

### Added
- `/introsio-pause` and `/introsio-resume` for every agent (`int print-pause`,
  `int print-resume` for Windsurf): stop a task anywhere and continue it exactly,
  in the same or another agent.
- Hook feature `pause`: the working tree is snapshotted under
  `refs/introsio/paused/<taskId>` when a task is paused (nothing on a branch
  changes), the reported git position is checked, and the repository is compared
  with a pause before it is resumed — EXACT / DRIFT / BLOCKED. Tasks left by a
  session that died are named as interrupted, with its workerId.
- `int paused [--prune]`: pauses and interrupted work on this computer, offline.
- The push guard refuses pushing `refs/introsio/*` in every mode.
- MIT license (`LICENSE`), `author`, and this changelog.

## [0.1.0]

- Global setup for Claude Code, Codex, Gemini CLI, Cursor, OpenCode, VS Code
  and Windsurf; `/introsio-execute`; stop-guard and related hooks; `int stats`.

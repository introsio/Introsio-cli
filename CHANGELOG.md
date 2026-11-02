# Changelog

All notable changes to `introsio` (the `int` CLI) are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/) and the
project uses [semantic versioning](https://semver.org/).

## [Unreleased]

## [0.2.0]

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

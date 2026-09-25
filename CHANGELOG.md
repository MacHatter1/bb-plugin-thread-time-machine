# Changelog

All notable changes to Thread Time Machine are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-09-25

First release.

### Added

- A **Time Machine** sidebar panel that replays any thread's recorded events as a scrubbable filmstrip, with play and ← / → keys.
- A frame inspector for messages, reasoning, commands (output and exit code), tool calls, file changes as diffs, errors, stops, compactions, edited messages, approvals, questions and forks.
- Pin two frames to diff every file change between them.
- Support for every provider BB ships: Codex, Claude Code, Pi, Muse Code, Cursor, opencode, Grok and Antigravity, including sub-agent attribution.
- Live updates while a thread is running.
- `bb thread-time-machine dump <thread-id> [--json] [--limit <n>]` and a bundled agent skill.

[0.1.0]: https://github.com/MacHatter1/bb-plugin-thread-time-machine/releases/tag/v0.1.0

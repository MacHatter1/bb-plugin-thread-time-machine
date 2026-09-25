---
name: thread-time-machine
description: "Replay any thread's recorded session: dump a condensed timeline of a thread's commands, file changes, reasoning, and messages. Use to summarize what a thread did during a long session."
---

# Thread Time Machine

A read-only replay tool: it replays any thread's recorded session frame by
frame and lets humans scrub through it in the sidebar (Time Machine panel). It never edits
threads and is not meant to steer agents. It works for every provider
(Codex, Claude Code, Pi, Muse Code and the ACP agents).

## CLI

`bb thread-time-machine dump <thread-id> [--json] [--limit <n>]` prints a
thread's history as a condensed timeline (`HH:MM:SS kind label`), oldest
first. `--limit` keeps the newest n frames (default 200, max 5000). Use it to
summarize what a thread actually did over a long session without reading its
full transcript. Hidden threads (workers, sub-agents) work too.

- Kinds: `user`, `agent`, `reasoning`, `command`, `file`, `read`, `search`,
  `web`, `image`, `tool`, `task` (sub-agents, background tasks), `plan`,
  `compact`, `turn` (turn ends, stops), `system` (edits, forks, approvals,
  questions), `warning`, `error`.
- A `↳` before the label marks work done inside a sub-agent.
- `[failed]`, `[incomplete]` (its turn ended first), `[running]` and
  `[rejected]` flag unusual states; `(exit n)` flags a failed command.
- `--json` returns the frames array (fields: id, seq, createdAt, kind, label,
  detail, text, path, command, exitCode, durationMs, status, changes[],
  parentLabel). Output is capped at 1 MB, so older frames may be dropped
  (reported on stderr); lower `--limit` for smaller output.
- Some providers record less: Codex keeps reasoning encrypted (no text), and
  Pi edits, Muse Code and some Cursor edits carry no diff. Very long command
  output is shortened, and threads past ~40k events omit their oldest history.

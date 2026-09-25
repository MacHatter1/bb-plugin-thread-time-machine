// `bb thread-time-machine dump` argument parsing and text rendering.
import type { TimeMachineFrame } from "./frames";

export const USAGE = [
  "Usage:",
  "  bb thread-time-machine dump <thread-id> [--json] [--limit <n>]",
  "",
  "Prints the thread's event history as a condensed timeline, oldest first:",
  "  HH:MM:SS  <kind>  <label>",
  "--limit keeps the newest n frames (default 200, max 5000).",
].join("\n");

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 5000;

export type DumpArgs = { threadId: string; json: boolean; limit: number };

export function parseDumpArgs(argv: readonly string[]): DumpArgs | { error: string } {
  let json = false;
  let limit = DEFAULT_LIMIT;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let value: string | undefined;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--limit") value = argv[(i += 1)];
    else if (arg.startsWith("--limit=")) value = arg.slice("--limit=".length);
    else if (arg.startsWith("-")) return { error: `Unknown option ${arg}\n\n${USAGE}` };
    else {
      positional.push(arg);
      continue;
    }
    const parsed = Number(value);
    if (value === undefined || !Number.isInteger(parsed) || parsed <= 0) {
      return { error: `--limit needs a positive whole number\n\n${USAGE}` };
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }
  const [command, threadId, ...extra] = positional;
  if (command !== "dump" || threadId === undefined || extra.length > 0) return { error: USAGE };
  return { threadId, json, limit };
}

function time(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function renderDump(frames: readonly TimeMachineFrame[], limit: number, truncated: boolean): string {
  if (frames.length === 0) return "No replayable events for this thread.";
  const shown = frames.slice(-limit);
  const lines = shown.map((frame) => {
    const suffix =
      frame.command !== null && frame.kind !== "command" ? `  $ ${frame.command.split("\n")[0]}`
      : frame.exitCode !== null && frame.exitCode !== 0 ? `  (exit ${frame.exitCode})`
      : "";
    const status = frame.status === "failed" || frame.status === "incomplete" || frame.status === "running" || frame.status === "rejected" ? ` [${frame.status}]` : "";
    const scope = frame.parentLabel !== null ? "  ↳ " : "  ";
    return `${time(frame.createdAt)}  ${frame.kind.padEnd(9)}${scope}${frame.label}${status}${suffix}`;
  });
  if (frames.length > limit) lines.unshift(`… ${frames.length - limit} earlier frames omitted (use --limit)`);
  if (truncated) lines.unshift("… oldest history omitted: this thread is very long");
  return lines.join("\n");
}

/** BB rejects plugin CLI output over 1 MiB; leave room for stderr. */
export const CLI_OUTPUT_BUDGET = 1_000_000;

/** The newest frames (up to `limit`) whose JSON array fits the CLI budget. */
export function renderJson(
  frames: readonly TimeMachineFrame[],
  limit: number,
  budget = CLI_OUTPUT_BUDGET,
): { stdout: string; omitted: number } {
  const kept: string[] = [];
  let size = 2;
  for (let i = frames.length - 1; i >= Math.max(0, frames.length - limit); i -= 1) {
    const json = JSON.stringify(frames[i]);
    if (size + json.length + 1 > budget) break;
    kept.push(json);
    size += json.length + 1;
  }
  kept.reverse();
  return { stdout: `[${kept.join(",")}]`, omitted: Math.min(frames.length, limit) - kept.length };
}

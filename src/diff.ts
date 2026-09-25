// Turn whatever a provider stored as a change's "diff" into a single-file
// unified patch that `experimental_Diff` can render.
//
// What providers actually store:
// - codex updates: bare `@@` hunks, no file headers.
// - codex adds/deletes: the raw file content, no prefixes at all.
// - claude-code, pi, cursor, grok, antigravity: `---`/`+++` headers followed
//   by `+`/`-`/` ` lines but no `@@` hunk header (so no line positions).
// - muse, muse-code: no diff.

export interface NormalizedPatch {
  patch: string;
  /** True when the hunk header was invented, so line numbers are not real. */
  synthetic: boolean;
  /** True when the stored diff was cut short (by the provider or the server cap). */
  truncated: boolean;
  added: number;
  removed: number;
}

function isHeaderPair(lines: string[], index: number): boolean {
  return (
    lines[index]?.startsWith("--- ") === true &&
    lines[index + 1]?.startsWith("+++ ") === true
  );
}

export function normalizePatch(
  raw: string,
  path: string,
  kind: "add" | "delete" | "update",
): NormalizedPatch {
  const text = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const lines = text === "" ? [] : text.split("\n");
  // A capped diff ends with a marker line; drop it and say so instead.
  let truncated = false;
  while (lines.length > 0 && /^\u2026\[.*truncated\]$/.test(lines[lines.length - 1])) {
    lines.pop();
    truncated = true;
  }
  const hasHunk = lines.some((line) => /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line));
  const headerAt = lines.findIndex((_, index) => isHeaderPair(lines, index));
  const body =
    headerAt >= 0 ? lines.slice(headerAt + 2)
    : hasHunk ? lines.slice(lines.findIndex((line) => line.startsWith("@@")))
    : null;

  const oldName = kind === "add" ? "/dev/null" : `a/${path.replace(/^\/+/, "")}`;
  const newName = kind === "delete" ? "/dev/null" : `b/${path.replace(/^\/+/, "")}`;
  const header = `--- ${oldName}\n+++ ${newName}`;

  if (body === null) {
    // Raw file content: the whole file was added or deleted.
    const sign = kind === "delete" ? "-" : "+";
    const count = lines.length;
    const hunk = kind === "delete" ? `@@ -1,${count} +0,0 @@` : `@@ -0,0 +1,${count} @@`;
    return {
      patch: [header, hunk, ...lines.map((line) => sign + line)].join("\n"),
      synthetic: false,
      truncated,
      added: kind === "delete" ? 0 : count,
      removed: kind === "delete" ? count : 0,
    };
  }

  let added = 0;
  let removed = 0;
  let context = 0;
  for (const line of body) {
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
    else if (line.startsWith(" ") || line === "") context += 1;
  }

  if (hasHunk) return { patch: [header, ...recountHunks(body)].join("\n"), synthetic: false, truncated, added, removed };

  // Headers but no hunk: invent one spanning the recorded lines. Lines
  // without a +/-/space prefix are context the provider dropped the space on.
  const fixed = body.map((line) => (/^[+\- ]/.test(line) ? line : ` ${line}`));
  const oldCount = removed + context;
  const newCount = added + context;
  const hunk = `@@ -${oldCount === 0 ? 0 : 1},${oldCount} +${newCount === 0 ? 0 : 1},${newCount} @@`;
  return {
    patch: [header, hunk, ...fixed].join("\n"),
    synthetic: kind !== "add" && kind !== "delete",
    truncated,
    added,
    removed,
  };
}

/**
 * Rewrite each hunk header's line counts from the lines actually present, so
 * a hunk cut short by a cap still parses. Start lines are kept.
 */
function recountHunks(body: string[]): string[] {
  const out: string[] = [];
  let headerIndex = -1;
  let oldStart = "1";
  let newStart = "1";
  let oldCount = 0;
  let newCount = 0;
  const flush = () => {
    if (headerIndex >= 0) out[headerIndex] = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${out[headerIndex]}`;
  };
  for (const line of body) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (header !== null) {
      flush();
      [oldStart, newStart] = [header[1], header[2]];
      oldCount = 0;
      newCount = 0;
      headerIndex = out.length;
      out.push(header[3]);
      continue;
    }
    if (headerIndex < 0) continue; // Text before the first hunk is not part of the patch.
    if (line.startsWith("\\")) {
      out.push(line);
      continue;
    }
    const fixed = /^[+\- ]/.test(line) ? line : ` ${line}`;
    if (!fixed.startsWith("+")) oldCount += 1;
    if (!fixed.startsWith("-")) newCount += 1;
    out.push(fixed);
  }
  flush();
  return out;
}

/**
 * Split one stored change into the edits it holds. Header-only diffs (Claude
 * Code, Pi, the ACP agents) carry no hunk positions, so an edit call that
 * replaced several places arrives as back-to-back old/new runs. Rendered as
 * one hunk, the viewer would merge them into a single block. Each old/new
 * run becomes its own patch here. Diffs with real `@@` hunks, and whole-file
 * adds and deletes, stay as one patch.
 */
export function splitPatch(raw: string, path: string, kind: "add" | "delete" | "update"): NormalizedPatch[] {
  const whole = normalizePatch(raw, path, kind);
  if (!whole.synthetic) return [whole];
  const lines = whole.patch.split("\n");
  const [oldHeader, newHeader] = lines;
  const body = lines.slice(3);

  const runs: string[][] = [];
  let current: string[] = [];
  let sawAdded = false;
  for (const line of body) {
    // A removal (or context) after an addition starts the next old/new pair.
    if (sawAdded && !line.startsWith("+")) {
      runs.push(current);
      current = [];
      sawAdded = false;
    }
    current.push(line);
    if (line.startsWith("+")) sawAdded = true;
  }
  if (current.length > 0) runs.push(current);
  if (runs.length <= 1) return [whole];

  return runs.map((run, index) => {
    const removed = run.filter((l) => l.startsWith("-")).length;
    const added = run.filter((l) => l.startsWith("+")).length;
    const context = run.length - removed - added;
    const oldCount = removed + context;
    const newCount = added + context;
    return {
      patch: [oldHeader, newHeader, `@@ -${oldCount === 0 ? 0 : 1},${oldCount} +${newCount === 0 ? 0 : 1},${newCount} @@`, ...run].join("\n"),
      synthetic: true,
      truncated: whole.truncated && index === runs.length - 1,
      added,
      removed,
    };
  });
}

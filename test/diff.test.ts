import { describe, expect, it } from "vitest";
import { normalizePatch, splitPatch } from "../src/diff";
import { buildFrames } from "../src/frames";
import { fixture } from "./helpers";

describe("normalizePatch", () => {
  it("adds file headers to codex's bare hunks and keeps real line numbers", () => {
    const result = normalizePatch("@@ -5,2 +5,2 @@\n a\n-b\n+c", "/w/src/x.ts", "update");
    expect(result.patch).toBe("--- a/w/src/x.ts\n+++ b/w/src/x.ts\n@@ -5,2 +5,2 @@\n a\n-b\n+c");
    expect(result).toMatchObject({ synthetic: false, added: 1, removed: 1 });
  });

  it("invents a hunk for ACP/Claude/Pi header-only diffs", () => {
    const raw = "--- a/x.md\n+++ b/x.md\n-beta\n+gamma\n";
    const result = normalizePatch(raw, "/w/x.md", "update");
    expect(result.patch).toBe("--- a/w/x.md\n+++ b/w/x.md\n@@ -1,1 +1,1 @@\n-beta\n+gamma");
    expect(result).toMatchObject({ synthetic: true, added: 1, removed: 1 });
  });

  it("treats codex's raw added content as a new file", () => {
    const result = normalizePatch("line one\nline two\n", "/w/new.ts", "add");
    expect(result.patch).toBe("--- /dev/null\n+++ b/w/new.ts\n@@ -0,0 +1,2 @@\n+line one\n+line two");
    expect(result.added).toBe(2);
  });

  it("treats codex's raw deleted content as removed lines, not additions", () => {
    const result = normalizePatch("gone\nalso gone", "/w/old.ts", "delete");
    expect(result.patch).toBe("--- a/w/old.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-gone\n-also gone");
    expect(result).toMatchObject({ added: 0, removed: 2 });
  });

  it("does not mistake YAML front matter for a diff header", () => {
    const result = normalizePatch("---\nname: x\n---\n# Title", "/w/SKILL.md", "delete");
    expect(result.patch.split("\n").slice(3)).toEqual(["----", "-name: x", "----", "-# Title"]);
  });

  it("produces a hunk for every captured provider diff", () => {
    const names = ["codex-delete", "probe-codex", "probe-claude-code", "probe-pi", "probe-acp-grok", "probe-acp-antigravity"];
    for (const name of names) {
      for (const frame of buildFrames(fixture(name).events)) {
        for (const change of frame.changes) {
          if (change.diff === null) continue;
          const { patch } = normalizePatch(change.diff, change.path, change.kind);
          const lines = patch.split("\n");
          expect(lines[0], name).toMatch(/^--- /);
          expect(lines[1], name).toMatch(/^\+\+\+ /);
          expect(lines[2], name).toMatch(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/);
          expect(lines.slice(3).every((line) => /^[+\- @]/.test(line) || line === "\\ No newline at end of file"), name).toBe(true);
        }
      }
    }
  });
});

describe("normalizePatch with capped diffs", () => {
  it("drops the truncation marker and recounts the cut hunk", () => {
    const raw = "@@ -10,5 +10,6 @@ fn\n a\n-b\n+c\n…[truncated]";
    const result = normalizePatch(raw, "x.ts", "update");
    expect(result.truncated).toBe(true);
    expect(result.patch.split("\n").slice(2)).toEqual(["@@ -10,2 +10,2 @@ fn", " a", "-b", "+c"]);
  });

  it("marks a capped header-only diff as truncated", () => {
    const result = normalizePatch("--- a/x\n+++ b/x\n+one\n…[truncated]", "x", "update");
    expect(result).toMatchObject({ truncated: true, added: 1 });
    expect(result.patch.endsWith("+one")).toBe(true);
  });
});

describe("splitPatch", () => {
  it("splits a Claude Code edit that replaced two places into two patches", () => {
    const [file] = buildFrames(fixture("claude-code-multi-edit").events).filter((f) => f.path?.endsWith("/todo.js"));
    const [change] = file.changes;
    const parts = splitPatch(change.diff ?? "", change.path, change.kind);
    expect(parts).toHaveLength(2);
    expect(parts[0].patch).toContain("-export function addTask(tasks, text) {");
    expect(parts[0].patch).not.toContain("formatTask");
    expect(parts[0]).toMatchObject({ removed: 2, added: 2 });
    expect(parts[1].patch).toContain("+  const due = task.due");
    expect(parts[1]).toMatchObject({ removed: 1, added: 2 });
    for (const part of parts) expect(part.patch.split("\n")[2]).toMatch(/^@@ -1,\d+ \+1,\d+ @@$/);
  });

  it("keeps a single old/new pair, a pure addition and real hunks whole", () => {
    expect(splitPatch("--- a/x\n+++ b/x\n-a\n+b\n", "x", "update")).toHaveLength(1);
    expect(splitPatch("--- /dev/null\n+++ b/x\n+a\n+b\n", "x", "add")).toHaveLength(1);
    expect(splitPatch("@@ -1,1 +1,1 @@\n-a\n+b\n@@ -9,1 +9,1 @@\n-c\n+d", "x", "update")).toHaveLength(1);
  });

  it("splits at context that follows an addition", () => {
    const parts = splitPatch("--- a/x\n+++ b/x\n-a\n+b\n keep\n-c\n+d", "x", "update");
    expect(parts.map((p) => p.patch.split("\n").slice(3))).toEqual([["-a", "+b"], [" keep", "-c", "+d"]]);
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_LIMIT, MAX_LIMIT, parseDumpArgs, renderDump, renderJson, USAGE } from "../src/cli";
import { buildFrames } from "../src/frames";
import { fixture } from "./helpers";

describe("parseDumpArgs", () => {
  it.each([
    [["dump", "thr_a"], { threadId: "thr_a", json: false, limit: DEFAULT_LIMIT }],
    [["dump", "thr_a", "--json", "--limit", "5"], { threadId: "thr_a", json: true, limit: 5 }],
    [["--limit=9", "dump", "thr_a"], { threadId: "thr_a", json: false, limit: 9 }],
    [["dump", "thr_a", "--limit", "999999"], { threadId: "thr_a", json: false, limit: MAX_LIMIT }],
  ])("%j", (argv, expected) => {
    expect(parseDumpArgs(argv)).toEqual(expected);
  });

  it.each([[[]], [["dump"]], [["dump", "a", "b"]], [["show", "a"]]])("rejects %j with usage", (argv) => {
    expect(parseDumpArgs(argv)).toEqual({ error: USAGE });
  });

  it("rejects a bad --limit instead of treating it as the thread id", () => {
    expect(parseDumpArgs(["dump", "thr_a", "--limit", "abc"])).toMatchObject({ error: expect.stringMatching(/--limit/) });
    expect(parseDumpArgs(["dump", "thr_a", "--bogus"])).toMatchObject({ error: expect.stringMatching(/Unknown option/) });
  });
});

describe("renderDump", () => {
  const frames = buildFrames(fixture("probe-codex").events);

  it("prints one line per frame, oldest first", () => {
    const lines = renderDump(frames, 100, false).split("\n");
    expect(lines).toHaveLength(frames.length);
    expect(lines[0]).toMatch(/^\d\d:\d\d:\d\d  user {7}User message$/);
    expect(lines.find((l) => l.includes("ls probe/does-not-exist"))).toMatch(/\[failed\]  \(exit 1\)$/);
  });

  it("notes omitted and truncated history", () => {
    const text = renderDump(frames, 2, true);
    expect(text.split("\n").slice(0, 2)).toEqual([
      "\u2026 oldest history omitted: this thread is very long",
      `\u2026 ${frames.length - 2} earlier frames omitted (use --limit)`,
    ]);
  });

  it("says so when there is nothing to replay", () => {
    expect(renderDump([], 10, false)).toBe("No replayable events for this thread.");
  });
});

describe("renderJson", () => {
  const frames = buildFrames(fixture("probe-codex").events);

  it("returns the newest frames within the limit", () => {
    const { stdout, omitted } = renderJson(frames, 3);
    expect(JSON.parse(stdout)).toEqual(frames.slice(-3));
    expect(omitted).toBe(0);
  });

  it("drops the oldest frames to stay under the CLI output limit", () => {
    const budget = JSON.stringify(frames.slice(-2)).length + 10;
    const { stdout, omitted } = renderJson(frames, 100, budget);
    expect(stdout.length).toBeLessThanOrEqual(budget);
    expect(JSON.parse(stdout)).toEqual(frames.slice(-2));
    expect(omitted).toBe(frames.length - 2);
  });
});

import { describe, expect, it } from "vitest";
import type { RawEvent } from "../src/frames";
import { loadFrames, PAGE_SIZE, type ThreadsReader } from "../src/load";
import { fixture } from "./helpers";

/** An in-memory `threads` area with the real API's paging rules. */
function fakeReader(events: RawEvent[], threads: Record<string, unknown> = {}) {
  const calls: { types: readonly string[]; order: string }[] = [];
  const reader: ThreadsReader = {
    events: {
      async list(args) {
        const limit = Number(args.limit ?? 100);
        if (limit > 100) throw new Error("HTTP 400: Thread event limit cannot exceed 100");
        calls.push({ types: args.types ?? [], order: args.order ?? "asc" });
        let rows = events.filter((e) => args.types === undefined || (args.types as readonly string[]).includes(e.type));
        if (args.beforeSeq !== undefined) rows = rows.filter((e) => e.seq < Number(args.beforeSeq));
        if (args.afterSeq !== undefined) rows = rows.filter((e) => e.seq > Number(args.afterSeq));
        rows = [...rows].sort((a, b) => (args.order === "desc" ? b.seq - a.seq : a.seq - b.seq));
        return rows.slice(0, limit).map((e) => ({ ...e, id: `evt_${e.seq}`, threadId: "thr_x", scope: "turn" }));
      },
    },
    async get({ threadId }) {
      if (!(threadId in threads)) throw new Error("HTTP 404");
      return { thread: threads[threadId] };
    },
  };
  return { reader, calls };
}

/** A long thread: n completed commands, each with streamed output. */
function longThread(n: number): RawEvent[] {
  const events: RawEvent[] = [];
  let seq = 0;
  const push = (type: string, data: unknown) => events.push({ seq: ++seq, type, createdAt: 1_000 + seq, data });
  push("client/turn/requested", { initiator: "user", input: [{ type: "text", text: "go" }] });
  for (let i = 0; i < n; i += 1) {
    push("item/started", { item: { type: "commandExecution", id: `c${i}`, command: `echo ${i}` } });
    push("item/commandExecution/outputDelta", { itemId: `c${i}`, delta: `${i}\n` });
    push("item/completed", { item: { type: "commandExecution", id: `c${i}`, command: `echo ${i}`, aggregatedOutput: `${i}\n`, exitCode: 0 } });
  }
  push("turn/completed", { status: "completed" });
  return events;
}

describe("loadFrames", () => {
  it("pages through a long thread without dropping or repeating frames", async () => {
    const { reader, calls } = fakeReader(longThread(450));
    const { frames, truncated } = await loadFrames(reader, "thr_x");
    expect(truncated).toBe(false);
    expect(frames).toHaveLength(452);
    expect(new Set(frames.map((f) => f.id)).size).toBe(452);
    expect(frames[1]).toMatchObject({ kind: "command", command: "echo 0", text: "0\n" });
    // Completed items never need their deltas.
    expect(calls.every((c) => !c.types.includes("item/commandExecution/outputDelta"))).toBe(true);
    expect(calls[0].types).toContain("client/turn/requested");
  });

  it("keeps the newest history and reports truncation past the cap", async () => {
    const { reader } = fakeReader(longThread(450));
    const { frames, truncated } = await loadFrames(reader, "thr_x", { maxEvents: 3 * PAGE_SIZE });
    expect(truncated).toBe(true);
    expect(frames.at(-1)?.kind).toBe("turn");
    expect(frames.some((f) => f.kind === "user")).toBe(false);
  });

  it("reads deltas only when an item never completed", async () => {
    const { events } = fixture("pi-interrupted");
    const { reader, calls } = fakeReader(events);
    const { frames } = await loadFrames(reader, "thr_x");
    expect(calls.some((c) => c.types.includes("item/agentMessage/delta"))).toBe(true);
    const unfinished = frames.find((f) => f.kind === "agent" && f.status === "incomplete");
    expect(unfinished?.text).toMatch(/^Already done in the previous turn/);
  });

  it("adds a fork frame naming the source thread", async () => {
    const { events } = fixture("pi-fork");
    const { reader } = fakeReader(events, {
      thr_fork: { id: "thr_fork", originKind: "fork", sourceThreadId: "thr_src" },
      thr_src: { id: "thr_src", title: "Original work" },
    });
    const { frames } = await loadFrames(reader, "thr_fork");
    expect(frames[0]).toMatchObject({ kind: "system", label: "Forked from Original work" });
  });

  it("still loads when the thread lookup fails", async () => {
    const { reader } = fakeReader(fixture("pi-fork").events);
    const { frames } = await loadFrames(reader, "thr_missing");
    expect(frames[0].kind).toBe("user");
  });
});

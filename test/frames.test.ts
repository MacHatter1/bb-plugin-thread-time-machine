import { describe, expect, it } from "vitest";
import { buildFrames, fitOutputBudget, FRAME_KINDS, frameSchema, unwrapShell, type TimeMachineFrame } from "../src/frames";
import { ev, fixture, FIXTURE_NAMES, itemIds } from "./helpers";

function framesOf(name: string): TimeMachineFrame[] {
  return buildFrames(fixture(name).events);
}
const byKind = (frames: TimeMachineFrame[], kind: string) => frames.filter((f) => f.kind === kind);

describe("every captured fixture", () => {
  it.each(FIXTURE_NAMES)("%s: classifies every event without dropping any", (name) => {
    const { events } = fixture(name);
    const frames = buildFrames(events);
    const ids = frames.map((f) => f.id);

    for (const frame of frames) {
      expect(() => frameSchema.parse(frame)).not.toThrow();
      expect(FRAME_KINDS).toContain(frame.kind);
      expect(frame.label.trim()).not.toBe("");
      expect(frame.createdAt).toBeGreaterThan(0);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(frames.map((f) => f.seq)).toEqual([...frames.map((f) => f.seq)].sort((a, b) => a - b));

    // Every item is a frame, except Claude Code's compaction heartbeats,
    // which fold into one frame.
    const frameIds = new Set(ids);
    const compactionIds = new Set(
      events
        .filter((e) => (e.data as { item?: { type?: string } }).item?.type === "contextCompaction")
        .map((e) => (e.data as { item: { id: string } }).item.id),
    );
    for (const id of itemIds(events)) {
      if (!compactionIds.has(id)) expect(frameIds, `item ${id}`).toContain(id);
    }

    // Every user request with input is a user frame.
    const requests = events.filter(
      (e) => e.type === "client/turn/requested" && ((e.data as { input?: unknown[] }).input?.length ?? 0) > 0,
    );
    expect(byKind(frames, "user")).toHaveLength(requests.length);
  });
});

describe("probe threads (same task on every provider)", () => {
  const providers = ["codex", "claude-code", "pi", "acp-cursor", "acp-grok", "muse-code", "acp-antigravity"];

  it.each(providers)("%s: user prompt, output of `cat`, final reply and turn end", (provider) => {
    const frames = framesOf(`probe-${provider}`);
    expect(frames[0]).toMatchObject({ kind: "user", label: "User message" });
    expect(frames[0].text).toContain("short probe task");

    const cat = byKind(frames, "command").find((f) => f.command?.includes("cat probe/notes.md"));
    expect(cat?.text).toContain("gamma");
    expect(cat?.command).not.toMatch(/^\/bin\/zsh/);

    const agents = byKind(frames, "agent");
    expect(agents.at(-1)?.text).toMatch(/probe\/notes\.md/);
    expect(frames.at(-1)).toMatchObject({ kind: "turn", label: "Turn completed" });
    expect(frames.some((f) => f.status === "running" || f.status === "incomplete")).toBe(false);
  });

  it.each(["codex", "claude-code", "acp-grok", "acp-antigravity"])(
    "%s: records the failing command's exit code",
    (provider) => {
      const failed = byKind(framesOf(`probe-${provider}`), "command").find((f) => f.command === "ls probe/does-not-exist");
      expect(failed?.exitCode).toBe(1);
      expect(failed?.text).toContain("No such file");
    },
  );

  it.each([
    ["codex", ["update"]],
    ["claude-code", ["add", "update"]],
    ["acp-grok", ["add", "update"]],
    ["acp-antigravity", ["add", "update", "update"]],
  ])("%s: file changes carry diffs", (provider, kinds) => {
    const files = byKind(framesOf(`probe-${provider}`), "file");
    expect(files.flatMap((f) => f.changes.map((c) => c.kind))).toEqual(kinds);
    for (const change of files.flatMap((f) => f.changes)) {
      expect(change.path).toMatch(/probe\/notes\.md$/);
      expect(change.diff).not.toBeNull();
    }
  });

  it("pi and muse-code record file changes without diffs for edits", () => {
    const pi = byKind(framesOf("probe-pi"), "file");
    expect(pi.map((f) => f.changes[0].kind)).toEqual(["add", "update"]);
    expect(pi[1].changes[0].diff).toBeNull();
    const muse = byKind(framesOf("probe-muse-code"), "file");
    expect(muse.length).toBeGreaterThan(0);
    expect(muse.every((f) => f.changes.every((c) => c.diff === null))).toBe(true);
  });

  it("muse-code: bash tool calls are commands", () => {
    const frames = framesOf("probe-muse-code");
    expect(byKind(frames, "tool")).toHaveLength(0);
    const failed = byKind(frames, "command").find((f) => f.command === "ls probe/does-not-exist");
    expect(failed).toMatchObject({ status: "failed" });
    expect(failed?.text).toContain("No such file");
  });

  it("antigravity: unwraps the JSON command-output envelope", () => {
    const cat = byKind(framesOf("probe-acp-antigravity"), "command").find((f) => f.command?.startsWith("cat "));
    expect(cat?.text).toBe("alpha\ngamma\nnotes.md\n");
  });

  it("cursor: one combined shell command with its real exit code", () => {
    const [command] = byKind(framesOf("probe-acp-cursor"), "command");
    expect(command.exitCode).toBe(1);
    expect(command.text).toContain("gamma");
  });

  it("codex: labels commands without the shell wrapper and uses measured durations", () => {
    const commands = byKind(framesOf("probe-codex"), "command");
    expect(commands.map((f) => f.label)).toContain("cat probe/notes.md && ls probe");
    expect(commands.every((f) => f.durationMs === null || f.durationMs > 0)).toBe(true);
  });

  it("opencode: a thread that fails to start shows the prompt and the error", () => {
    const setModel = framesOf("probe-acp-opencode-set-model");
    expect(setModel.map((f) => f.kind)).toEqual(["user", "error"]);
    expect(setModel[1].text).toContain("session/set_model");
    const noRoute = framesOf("probe-acp-opencode-no-route");
    expect(noRoute.map((f) => f.kind)).toEqual(["user", "error", "turn", "warning"]);
    expect(noRoute[2]).toMatchObject({ label: "Turn failed", status: "failed" });
  });
});

describe("provider-specific shapes", () => {
  it("codex reasoning has no recorded text and never borrows another frame's", () => {
    const reasoning = byKind(framesOf("codex-image-view"), "reasoning");
    expect(reasoning.length).toBeGreaterThan(0);
    for (const frame of reasoning) {
      expect(frame.text).toBeNull();
      expect(frame.detail).toMatch(/did not record/);
    }
  });

  it("codex image views and generations are image frames without base64", () => {
    expect(byKind(framesOf("codex-image-view"), "image")[0].label).toMatch(/^Viewed .+\.png$/);
    const [generated] = byKind(framesOf("codex-image-generation"), "image");
    expect(generated.label).toMatch(/^Generated /);
    expect(generated.text).toContain("Use case");
    expect(generated.text).not.toMatch(/iVBORw0KGgo/);
  });

  it("codex multi-file edits keep every change, including deletes", () => {
    const [file] = byKind(framesOf("codex-delete"), "file");
    expect(file.label).toBe("Edited 4 files");
    expect(file.changes.map((c) => c.kind)).toContain("delete");
  });

  it("codex delegations and compactions have frames", () => {
    expect(byKind(framesOf("codex-delegation"), "task")[0].label).toBe("Sub-agent: /root/check_backend_fit");
    expect(byKind(framesOf("codex-compaction"), "compact")).toHaveLength(1);
  });

  it("claude-code: a long compaction's heartbeats and thread/compacted fold into one frame", () => {
    const compact = byKind(framesOf("claude-code-compaction"), "compact");
    expect(compact).toHaveLength(1);
    expect(compact[0].seq).toBe(7528);
    expect(compact[0].status).not.toBe("incomplete");
  });

  it("pi: an unfinished compaction item plus thread/compacted is one completed frame", () => {
    const compact = byKind(framesOf("pi-compaction"), "compact");
    expect(compact).toHaveLength(1);
    expect(compact[0].status).toBeNull();
  });

  it("claude-code: sub-agent work is attributed to its delegation", () => {
    const frames = framesOf("claude-code-subagent");
    const delegation = byKind(frames, "task").find((f) => f.label.startsWith("Sub-agent:"));
    expect(delegation).toBeDefined();
    const inside = frames.filter((f) => f.parentLabel !== null);
    expect(inside.length).toBeGreaterThan(0);
    expect(inside.some((f) => delegation?.label.endsWith(f.parentLabel ?? "\0"))).toBe(true);
  });

  it("claude-code: background tasks without item/started still get a real time", () => {
    const tasks = byKind(framesOf("claude-code-background"), "task");
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      expect(task.label).toMatch(/^Background: /);
      expect(task.createdAt).toBeGreaterThan(0);
    }
  });

  it("interactions become one frame each, with the answer", () => {
    const [question] = byKind(framesOf("claude-code-question"), "system");
    expect(question).toMatchObject({ label: "Question: License", status: "resolved" });
    expect(question.text).toMatch(/→ /);
    const [museQuestion] = byKind(framesOf("muse-code-question"), "system");
    expect(museQuestion.text).toMatch(/→ /);
    const approvals = byKind(framesOf("acp-antigravity-approval"), "system");
    expect(approvals).toHaveLength(1);
    expect(approvals[0].label).toBe("Approval: git status");
    expect(byKind(framesOf("acp-cursor-approval"), "system")[0]).toMatchObject({ status: "resolved", text: "allow_for_session" });
  });

  it("stopped turns: stop, interrupted turn, and unfinished items keep their streamed text", () => {
    const frames = framesOf("pi-interrupted");
    expect(frames.map((f) => f.label)).toEqual(expect.arrayContaining(["Stopped by user", "Turn interrupted"]));
    const unfinished = byKind(frames, "agent").find((f) => f.status === "incomplete");
    expect(unfinished?.text).toMatch(/^Already done in the previous turn/);
    const codex = framesOf("codex-interrupted");
    expect(codex.filter((f) => f.status === "incomplete").length).toBeGreaterThan(0);
    expect(codex.some((f) => f.status === "pending")).toBe(false);
  });

  it("edited messages are marked where the replaced turn was removed", () => {
    for (const name of ["pi-edited-message", "codex-edited-message", "claude-code-edited-message"]) {
      const edits = framesOf(name).filter((f) => f.label === "Message edited");
      expect(edits, name).toHaveLength(1);
      expect(edits[0].text).toMatch(/no longer in this thread/);
    }
  });

  it("rejected messages are flagged, and failures are errors", () => {
    const frames = framesOf("acp-antigravity-rejected");
    expect(byKind(frames, "user").every((f) => f.status === "rejected")).toBe(true);
    expect(byKind(frames, "error").map((f) => f.label)).toContain("Message rejected");
    expect(framesOf("muse-code-question").some((f) => f.kind === "error" && /exited unexpectedly/.test(f.label))).toBe(true);
  });

  it("provider errors that will retry are warnings", () => {
    const [warning] = byKind(framesOf("claude-code-provider-error"), "warning");
    expect(warning.label).toBe("Provider error (retrying)");
    expect(warning.text).toMatch(/retry 1\/10/);
  });

  it("grok delegations and tool calls use their real names", () => {
    const frames = framesOf("acp-grok-delegation");
    expect(byKind(frames, "task")[0].label).toBe("Sub-agent: [reviewer] pr #5");
    expect(byKind(frames, "tool")[0].label).toMatch(/^get_command_or_subagent_output/);
  });

  it("forked threads say where they came from", () => {
    const frames = buildFrames(fixture("pi-fork").events, { forkedFrom: { threadId: "thr_source", title: "Source" } });
    expect(frames[0]).toMatchObject({ kind: "system", label: "Forked from Source", detail: "thr_source" });
    expect(frames[1].kind).toBe("user");
  });
});

describe("synthetic edge cases", () => {
  it("concatenates deltas in sequence order when an item never completed", () => {
    const events = [
      ev("item/started", { item: { type: "agentMessage", id: "m1" } }),
      ev("item/agentMessage/delta", { itemId: "m1", delta: "Hel" }),
      ev("item/agentMessage/delta", { itemId: "m1", delta: "lo" }),
    ];
    const [frame] = buildFrames([...events].reverse());
    expect(frame).toMatchObject({ kind: "agent", text: "Hello", status: "running" });
  });

  it("an item seen only through deltas still gets a frame", () => {
    const [frame] = buildFrames([ev("item/commandExecution/outputDelta", { itemId: "c1", delta: "out" })]);
    expect(frame).toMatchObject({ id: "c1", kind: "tool", text: "out" });
  });

  it("an item kind added later falls back to its presentation", () => {
    const [frame] = buildFrames([
      ev("item/completed", { item: { type: "hologram", id: "h1", presentation: { title: "Rendered a hologram" } } }),
    ]);
    expect(frame).toMatchObject({ kind: "tool", label: "Rendered a hologram" });
  });

  it("tool calls show the tool, its arguments and its result", () => {
    const [frame] = buildFrames([
      ev("item/completed", {
        item: { type: "toolCall", id: "t1", server: "bb", tool: "ultragoal_state", arguments: { plan_limit: 50 }, result: { ok: true } },
      }),
    ]);
    expect(frame.label).toBe("bb · ultragoal_state");
    expect(frame.detail).toContain('"plan_limit": 50');
    expect(frame.text).toContain('"ok": true');
  });

  it("user input parts are all shown", () => {
    const [frame] = buildFrames([
      ev("client/turn/requested", {
        initiator: "agent",
        senderThreadId: "thr_parent",
        input: [{ type: "text", text: "look" }, { type: "localImage", path: "/tmp/a.png" }],
      }),
    ]);
    expect(frame).toMatchObject({ kind: "user", label: "Message from thr_parent", text: "look\n[image: /tmp/a.png]" });
  });

  it("caps huge outputs", () => {
    const [frame] = buildFrames([
      ev("item/completed", { item: { type: "commandExecution", id: "c", command: "yes", aggregatedOutput: "y\n".repeat(50_000) } }),
    ]);
    expect(frame.text?.length).toBeLessThan(10_000);
    expect(frame.text).toMatch(/truncated\]$/);
  });
});

describe("unwrapShell", () => {
  it.each([
    ['/bin/zsh -lc "ls -la"', "ls -la"],
    ["bash -lc 'echo hi'", "echo hi"],
    ['/bin/zsh -lc "echo \\"q\\""', 'echo "q"'],
    ['/bin/zsh -lc "cut short', "cut short"],
    ["git status", "git status"],
  ])("%s", (input, expected) => {
    expect(unwrapShell(input)).toBe(expected);
  });
});

describe("fitOutputBudget", () => {
  const command = (id: string, output: string): TimeMachineFrame => ({
    ...buildFrames([ev("item/completed", { item: { type: "commandExecution", id, command: "x", aggregatedOutput: output } })])[0],
  });

  it("leaves small threads untouched", () => {
    const frames = [command("a", "short")];
    expect(fitOutputBudget(frames, 1000)[0].text).toBe("short");
  });

  it("shortens every long output to a head-and-tail preview when over budget", () => {
    const long = "h".repeat(3000) + "t".repeat(3000);
    const frames = fitOutputBudget([command("a", long), command("b", long), command("c", "tiny")], 2000);
    expect(frames[0].text).toBe(`${"h".repeat(333)}\n\u2026[5334 characters omitted: long thread]\u2026\n${"t".repeat(333)}`);
    expect(frames[2].text).toBe("tiny");
  });
});

// Pure event → frame normalisation. No SDK calls here, so every provider's
// recorded shapes can be tested against captured fixtures.
//
// Every provider BB ships (codex, claude-code, pi, the ACP agents, muse-code)
// records agent work as item lifecycle events: `item/started`, zero or more
// `item/<kind>/<delta>` events, then `item/completed` (or, for background
// tasks and delegations, `item/backgroundTask/completed` and
// `item/delegation/completed`). User input is `client/turn/requested`. The
// rest are thread-level notices (turn status, stops, errors, compaction,
// edits, approvals).
import { z } from "zod";

export const changeSchema = z.object({
  path: z.string(),
  kind: z.enum(["add", "delete", "update"]),
  movePath: z.string().nullable(),
  diff: z.string().nullable(),
});

export const frameSchema = z.object({
  /** Stable key: the item id for items, `seq:<n>` for single events. */
  id: z.string(),
  /** Sequence of the event that opened the frame; frames are ordered by it. */
  seq: z.number(),
  createdAt: z.number(),
  kind: z.string(),
  label: z.string(),
  detail: z.string().nullable(),
  text: z.string().nullable(),
  path: z.string().nullable(),
  command: z.string().nullable(),
  exitCode: z.number().nullable(),
  durationMs: z.number().nullable(),
  status: z.string().nullable(),
  changes: z.array(changeSchema),
  /** Title of the sub-agent (delegation) this frame ran inside, if any. */
  parentLabel: z.string().nullable(),
});

export type TimeMachineChange = z.infer<typeof changeSchema>;
export type TimeMachineFrame = z.infer<typeof frameSchema>;

export interface RawEvent {
  seq: number;
  type: string;
  createdAt: number;
  data: unknown;
}

/** Every kind a frame can have; the app has presentation for each. */
export const FRAME_KINDS = [
  "user", "agent", "reasoning", "tool", "command", "file", "read", "search",
  "web", "image", "task", "plan", "compact", "turn", "system", "warning", "error",
] as const;

// Caps keep a huge thread's RPC payload bounded.
const MESSAGE_CAP = 20_000;
const OUTPUT_CAP = 8_000;
const DETAIL_CAP = 2_000;
const DIFF_CAP = 60_000;
const CHANGES_PER_ITEM = 200;
const TRUNCATED = "\n\u2026[truncated]";

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function cap(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) + TRUNCATED : value;
}
function str(value: unknown, limit = MESSAGE_CAP): string | null {
  return typeof value === "string" ? cap(value, limit) : null;
}
function text(value: unknown, limit = MESSAGE_CAP): string | null {
  const s = str(value, limit);
  return s !== null && s.trim() !== "" ? s : null;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function positive(value: number | null): number | null {
  return value !== null && value > 0 ? value : null;
}
function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
function oneLine(value: string, limit = 90): string {
  const line = value.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > limit ? line.slice(0, limit - 1) + "\u2026" : line;
}
/** Tool arguments/results can be any JSON; show strings as-is. */
function jsonText(value: unknown, limit: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return text(value, limit);
  try {
    const json = JSON.stringify(value, null, 2);
    return json === "{}" || json === "[]" ? null : cap(json, limit);
  } catch {
    return null;
  }
}

/** `/bin/zsh -lc "cmd"` → `cmd` (codex wraps every command this way). */
export function unwrapShell(command: string): string {
  // The closing quote is optional so a command cut short still unwraps.
  const match = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(["'])([\s\S]*?)(?:\1\s*)?$/.exec(command.trim());
  if (match === null) return command.trim();
  return match[1] === '"' ? match[2].replace(/\\(["\\$`])/g, "$1") : match[2];
}

/**
 * Antigravity stores command output as a JSON envelope
 * (`{commandLine, exitCode, combinedOutput}`); unwrap it to the text.
 */
function commandOutput(value: unknown): { output: string | null; exitCode: number | null } {
  const raw = typeof value === "string" ? value : null;
  if (raw !== null && raw.startsWith("{") && raw.includes("combinedOutput")) {
    try {
      const parsed = obj(JSON.parse(raw));
      if (typeof parsed.combinedOutput === "string") {
        return { output: text(parsed.combinedOutput, OUTPUT_CAP), exitCode: num(parsed.exitCode) };
      }
    } catch {
      // Truncated envelope: fall through and show it raw.
    }
  }
  return { output: text(raw, OUTPUT_CAP), exitCode: null };
}

function presentationTitle(item: Record<string, unknown>): string | null {
  return text(obj(item.presentation).title, 200);
}
function presentationLabel(item: Record<string, unknown>): string | null {
  const label = obj(obj(item.presentation).label);
  return text(label.completed, 200) ?? text(label.pending, 200);
}

export function extractChanges(value: unknown): TimeMachineChange[] {
  return arr(value).slice(0, CHANGES_PER_ITEM).flatMap((raw) => {
    const change = obj(raw);
    if (typeof change.path !== "string") return [];
    const kind = change.kind === "add" || change.kind === "delete" ? change.kind : "update";
    return [{
      path: change.path,
      kind,
      movePath: str(change.movePath, 1000),
      diff: str(change.diff, DIFF_CAP),
    }];
  });
}

// ---------------------------------------------------------------------------
// Item accumulation
// ---------------------------------------------------------------------------

interface ItemState {
  id: string;
  type: string;
  seq: number;
  startedAt: number;
  completedAt: number | null;
  /** Latest payload wins field by field (completed over started). */
  item: Record<string, unknown>;
  deltas: string;
  completed: boolean;
}

/** Streaming delta event types; their text is only needed if an item never completed. */
export const DELTA_TYPES = [
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
] as const;

/** Every event type the replay reads, besides deltas. */
export const FRAME_TYPES = [
  "item/started",
  "item/completed",
  "item/backgroundTask/progress",
  "item/backgroundTask/completed",
  "item/delegation/completed",
  "client/turn/requested",
  "client/turn/rejected",
  "turn/started",
  "turn/completed",
  "system/thread/interrupted",
  "system/error",
  "provider/error",
  "provider/warning",
  "thread/compacted",
  "system/operation",
  "system/interaction/lifecycle",
] as const;

const ITEM_UPDATE_TYPES = new Set<string>([
  "item/started",
  "item/completed",
  "item/backgroundTask/progress",
  "item/backgroundTask/completed",
  "item/delegation/completed",
]);
const ITEM_COMPLETE_TYPES = new Set<string>([
  "item/completed",
  "item/backgroundTask/completed",
  "item/delegation/completed",
]);
const DELTA_TYPE_SET = new Set<string>(DELTA_TYPES);

function itemIdOf(data: Record<string, unknown>): string | null {
  if (typeof data.itemId === "string") return data.itemId;
  const id = obj(data.item).id;
  return typeof id === "string" ? id : null;
}

// ---------------------------------------------------------------------------
// Item → frame
// ---------------------------------------------------------------------------

function emptyFrame(id: string, seq: number, createdAt: number): Omit<TimeMachineFrame, "kind" | "label"> {
  return {
    id, seq, createdAt, detail: null, text: null, path: null, command: null,
    exitCode: null, durationMs: null, status: null, changes: [], parentLabel: null,
  };
}

function itemFrame(state: ItemState, turnEnded: boolean): TimeMachineFrame {
  const item = state.item;
  const title = presentationTitle(item);
  const elapsed = state.completedAt !== null ? state.completedAt - state.startedAt : null;
  const base = {
    ...emptyFrame(state.id, state.seq, state.startedAt),
    // An item that never completed is still running, unless its turn ended.
    status: state.completed ? text(item.status, 100) : turnEnded ? "incomplete" : "running",
    // Codex reports durationMs 0 for every item; fall back to measured time.
    durationMs: positive(num(item.durationMs)) ?? positive(elapsed),
  };
  const deltas = state.deltas !== "" ? state.deltas : null;

  switch (state.type) {
    case "agentMessage": {
      const body = text(item.text) ?? (deltas !== null ? cap(deltas, MESSAGE_CAP) : null);
      return { ...base, kind: "agent", label: body !== null ? oneLine(body) : "Agent message", text: body };
    }
    case "userMessage": {
      const body = text(item.text) ?? userInputText(item.content);
      return { ...base, kind: "user", label: "User message", text: body };
    }
    case "reasoning": {
      const content = arr(item.content).filter((c): c is string => typeof c === "string").join("\n\n");
      const summary = arr(item.summary).filter((c): c is string => typeof c === "string").join("\n\n");
      const body = text(content, OUTPUT_CAP) ?? text(summary, OUTPUT_CAP) ?? (deltas !== null ? cap(deltas, OUTPUT_CAP) : null);
      return {
        ...base,
        kind: "reasoning",
        label: body !== null ? oneLine(body.replace(/\*\*/g, "")) : "Reasoning",
        // Codex records encrypted reasoning only; say so instead of showing nothing.
        detail: body === null ? "The provider did not record this reasoning's text." : null,
        text: body,
      };
    }
    case "commandExecution": {
      const command = typeof item.command === "string" ? cap(unwrapShell(item.command), DETAIL_CAP) : null;
      const { output, exitCode } = commandOutput(item.aggregatedOutput);
      return {
        ...base,
        kind: "command",
        label: command !== null && command !== "" ? oneLine(command) : title ?? "Command",
        command,
        detail: text(item.cwd, 500),
        exitCode: num(item.exitCode) ?? exitCode,
        text: output ?? (deltas !== null ? cap(deltas, OUTPUT_CAP) : null),
      };
    }
    case "fileChange": {
      const changes = extractChanges(item.changes);
      if (changes.length === 0 && deltas !== null && typeof item.path === "string") {
        changes.push({ path: item.path, kind: "update", movePath: null, diff: cap(deltas, DIFF_CAP) });
      }
      const verb = (kind: TimeMachineChange["kind"]) => (kind === "add" ? "Created" : kind === "delete" ? "Deleted" : "Edited");
      const label =
        changes.length === 1 ? `${verb(changes[0].kind)} ${basename(changes[0].path)}`
        : changes.length > 1 ? `Edited ${changes.length} files`
        : title ?? "File change";
      return { ...base, kind: "file", label, path: changes.length === 1 ? changes[0].path : null, changes };
    }
    case "fileRead": {
      const path = str(item.path, 1000);
      return { ...base, kind: "read", label: `Read ${path !== null ? basename(path) : title ?? "file"}`, path };
    }
    case "search": {
      const query = text(item.query, 500);
      return {
        ...base,
        kind: "search",
        label: query !== null ? `Search: ${oneLine(query, 80)}` : title ?? "Search",
        path: str(item.path, 1000),
        detail: query,
        command: text(item.cmd, DETAIL_CAP),
      };
    }
    case "toolCall": {
      const tool = text(item.tool, 200) ?? text(item.name, 200);
      const shell = shellToolCommand(tool, item.arguments);
      if (shell !== null) {
        // Muse Code (and some ACP agents) run shell commands as a tool call.
        const result = jsonText(item.result, OUTPUT_CAP) ?? (deltas !== null ? cap(deltas, OUTPUT_CAP) : null);
        return {
          ...base,
          kind: "command",
          label: oneLine(shell),
          command: shell,
          detail: text(obj(item.arguments).description, 500) ?? text(obj(item.arguments).cwd, 500),
          text: result,
        };
      }
      const server = text(item.server, 200);
      const name = tool !== null ? (server !== null ? `${server} \u00b7 ${tool}` : tool) : null;
      const error = text(obj(item.error).message, OUTPUT_CAP) ?? text(item.error, OUTPUT_CAP);
      return {
        ...base,
        kind: "tool",
        label: title !== null && name !== null && title !== name ? `${name}: ${oneLine(title, 70)}` : name ?? title ?? "Tool call",
        detail: jsonText(item.arguments, DETAIL_CAP),
        text: error ?? jsonText(item.result, OUTPUT_CAP) ?? text(item.resultText, OUTPUT_CAP) ?? (deltas !== null ? cap(deltas, OUTPUT_CAP) : null),
      };
    }
    case "webSearch": {
      const queries = arr(item.queries).filter((q): q is string => typeof q === "string");
      return {
        ...base,
        kind: "web",
        label: queries.length > 0 ? `Web search: ${oneLine(queries[0], 80)}` : title ?? "Web search",
        detail: queries.length > 1 ? cap(queries.join("\n"), DETAIL_CAP) : null,
        text: text(item.resultText, OUTPUT_CAP),
      };
    }
    case "webFetch": {
      const url = text(item.url, 1000);
      return {
        ...base,
        kind: "web",
        label: url !== null ? `Fetch ${oneLine(url, 90)}` : title ?? "Fetch page",
        path: url,
        detail: text(item.prompt, DETAIL_CAP),
        text: text(item.resultText, OUTPUT_CAP),
      };
    }
    case "imageGeneration":
    case "imageView": {
      const path = str(item.path, 1000) ?? str(item.outputFile, 1000);
      const generated = state.type === "imageGeneration";
      return {
        ...base,
        kind: "image",
        label: `${generated ? "Generated" : "Viewed"} ${path !== null ? basename(path) : "image"}`,
        path,
        text: generated ? text(item.prompt, OUTPUT_CAP) : null,
        detail: text(obj(item.error).message, 500) ?? text(item.error, 500),
      };
    }
    case "delegation": {
      const label = text(item.label, 200) ?? title;
      return {
        ...base,
        kind: "task",
        label: label !== null ? `Sub-agent: ${oneLine(label, 80)}` : "Sub-agent",
        detail: text(obj(item.presentation).detail, 500),
        text: text(item.summary, OUTPUT_CAP) ?? text(item.resultPreview, OUTPUT_CAP),
      };
    }
    case "backgroundTask": {
      const description = text(item.description, 200) ?? title;
      return {
        ...base,
        kind: "task",
        label: description !== null ? `Background: ${oneLine(description, 80)}` : "Background task",
        detail: text(item.taskType, 100),
        status: text(item.taskStatus, 100) ?? base.status,
        text: text(item.summary, OUTPUT_CAP) !== description ? text(item.summary, OUTPUT_CAP) : null,
      };
    }
    case "plan":
    case "planSteps": {
      const steps = arr(item.steps).map((s) => {
        const step = obj(s);
        const mark = step.status === "completed" ? "[x]" : step.status === "active" || step.status === "in_progress" ? "[>]" : "[ ]";
        return `${mark} ${String(step.step ?? step.text ?? "")}`;
      });
      return {
        ...base,
        kind: "plan",
        label: title !== null ? `Plan: ${oneLine(title, 80)}` : "Updated plan",
        text: steps.length > 0 ? cap(steps.join("\n"), OUTPUT_CAP) : text(item.text, OUTPUT_CAP),
      };
    }
    case "contextCompaction":
      return { ...base, kind: "compact", label: "Context compacted", text: text(item.summary, OUTPUT_CAP) };
    default:
      // A kind added after this plugin shipped: show what BB itself would.
      return {
        ...base,
        kind: "tool",
        label: title ?? presentationLabel(item) ?? (state.type !== "" ? state.type : "Event"),
        text: jsonText(item.result, OUTPUT_CAP) ?? (deltas !== null ? cap(deltas, OUTPUT_CAP) : null),
      };
  }
}

const SHELL_TOOLS = new Set(["bash", "shell", "run_shell_command", "run_terminal_cmd", "terminal", "exec", "execute_command"]);

function shellToolCommand(tool: string | null, args: unknown): string | null {
  if (tool === null || !SHELL_TOOLS.has(tool.toLowerCase())) return null;
  const a = obj(args);
  return text(a.command, DETAIL_CAP) ?? text(a.cmd, DETAIL_CAP);
}

function userInputText(input: unknown): string | null {
  const parts = arr(input).map((raw) => {
    const part = obj(raw);
    switch (part.type) {
      case "text":
        return typeof part.text === "string" ? part.text : "";
      case "image":
        return "[image]";
      case "localImage":
        return `[image: ${String(part.path ?? "?")}]`;
      case "localFile":
      case "file":
        return `[file: ${String(part.path ?? part.name ?? "?")}]`;
      case "skill":
        return `[skill: ${String(part.name ?? part.path ?? "?")}]`;
      default:
        return `[${String(part.type ?? "attachment")}]`;
    }
  });
  return text(parts.filter((p) => p !== "").join("\n"));
}

// ---------------------------------------------------------------------------
// Events → frames
// ---------------------------------------------------------------------------

function turnLabel(status: string | null): string {
  switch (status) {
    case "failed":
      return "Turn failed";
    case "interrupted":
      return "Turn interrupted";
    case "cancelled":
    case "canceled":
      return "Turn cancelled";
    default:
      return "Turn completed";
  }
}

function interactionFrame(base: Omit<TimeMachineFrame, "kind" | "label">, data: Record<string, unknown>): TimeMachineFrame | null {
  const interaction = obj(data.interaction);
  const payload = obj(interaction.payload);
  const status = text(interaction.status, 100);
  const resolution = obj(interaction.resolution);
  let label: string;
  let body: string | null = null;
  if (payload.kind === "approval") {
    const subject = obj(payload.subject);
    const what = text(subject.command, 200) ?? text(subject.path, 200) ?? text(subject.kind, 100) ?? "action";
    label = `Approval: ${oneLine(what, 80)}`;
    body = text(resolution.decision, 100) ?? text(resolution.kind, 100);
  } else if (payload.kind === "user_question") {
    const questions = arr(payload.questions).map(obj);
    label = `Question: ${oneLine(String(questions[0]?.shortLabel ?? questions[0]?.prompt ?? "input"), 80)}`;
    const answers = obj(resolution.answers);
    body = text(
      questions
        .map((q) => {
          const answer = obj(answers[String(q.id)]);
          const picked = [...arr(answer.selected).map(String), ...(typeof answer.freeText === "string" ? [answer.freeText] : [])];
          return `${String(q.prompt ?? q.id)}\n\u2192 ${picked.length > 0 ? picked.join(", ") : "(no answer)"}`;
        })
        .join("\n\n"),
      OUTPUT_CAP,
    );
  } else {
    label = text(payload.title, 200) ?? "Interaction";
  }
  return { ...base, id: `interaction:${String(interaction.id ?? base.seq)}`, kind: "system", label, status, text: body };
}

export interface BuildOptions {
  /** The thread this one was forked from, shown as the first frame. */
  forkedFrom?: { threadId: string; title: string | null } | null;
}

/**
 * Normalise a thread's events (any order; sorted here) into frames ordered by
 * the sequence that opened them.
 */
export function buildFrames(events: readonly RawEvent[], options: BuildOptions = {}): TimeMachineFrame[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const items = new Map<string, ItemState>();
  const single: TimeMachineFrame[] = [];
  const interactions = new Map<string, TimeMachineFrame>();
  const rejected = new Set<string>();
  const userByRequest = new Map<string, TimeMachineFrame>();
  let turnStartedAt: number | null = null;
  let lastCompaction: { state: ItemState; seq: number } | null = null;
  let lastCreated: ItemState | null = null;
  let lastTurnEndSeq = -1;

  for (const event of sorted) {
    const data = obj(event.data);
    const base = emptyFrame(`seq:${event.seq}`, event.seq, event.createdAt);

    if (ITEM_UPDATE_TYPES.has(event.type) || DELTA_TYPE_SET.has(event.type)) {
      const id = itemIdOf(data);
      if (id === null) continue;
      const payload = obj(data.item);
      let state = items.get(id);
      if (
        state === undefined &&
        payload.type === "contextCompaction" &&
        lastCreated?.type === "contextCompaction" &&
        !lastCreated.completed
      ) {
        // Claude Code re-announces a long compaction every 30s under a new
        // item id; treat the run as one compaction.
        state = lastCreated;
        items.set(id, state);
      }
      if (state === undefined) {
        state = {
          id,
          type: typeof payload.type === "string" ? payload.type : "",
          seq: event.seq,
          startedAt: event.createdAt,
          completedAt: null,
          item: {},
          deltas: "",
          completed: false,
        };
        items.set(id, state);
        lastCreated = state;
      }
      if (state.type === "" && typeof payload.type === "string") state.type = payload.type;
      if (DELTA_TYPE_SET.has(event.type)) {
        const delta = typeof data.delta === "string" ? data.delta : typeof data.outputDelta === "string" ? data.outputDelta : "";
        if (state.deltas.length < MESSAGE_CAP) state.deltas += delta;
        continue;
      }
      state.item = { ...state.item, ...payload };
      if (ITEM_COMPLETE_TYPES.has(event.type)) {
        state.completed = true;
        state.completedAt = event.createdAt;
      }
      if (state.type === "contextCompaction") lastCompaction = { state, seq: event.seq };
      continue;
    }

    switch (event.type) {
      case "client/turn/requested": {
        const input = arr(data.input);
        if (input.length === 0) break; // Fork bootstraps carry no input.
        const initiator = data.initiator;
        const sender = text(data.senderThreadId, 200);
        const target = text(obj(data.target).kind, 50);
        const label =
          initiator === "agent" ? (sender !== null ? `Message from ${sender}` : "Message from an agent")
          : initiator === "system" ? "System message"
          : target === "steer" ? "User message (steer)"
          : "User message";
        const frame: TimeMachineFrame = { ...base, kind: "user", label, text: userInputText(input) };
        const requestId = text(data.requestId, 200);
        if (requestId !== null) {
          frame.id = `request:${requestId}`;
          userByRequest.set(requestId, frame);
        }
        single.push(frame);
        break;
      }
      case "client/turn/rejected": {
        const requestId = text(data.requestId, 200);
        if (requestId !== null) rejected.add(requestId);
        single.push({ ...base, kind: "error", label: "Message rejected", text: text(data.message, OUTPUT_CAP), detail: text(data.reason, 200) });
        break;
      }
      case "turn/started":
        turnStartedAt = event.createdAt;
        break;
      case "turn/completed": {
        lastTurnEndSeq = event.seq;
        const status = text(data.status, 100);
        single.push({
          ...base,
          kind: "turn",
          label: turnLabel(status),
          status,
          durationMs: turnStartedAt !== null ? event.createdAt - turnStartedAt : null,
          text: text(obj(data.error).message, OUTPUT_CAP) ?? text(data.error, OUTPUT_CAP),
        });
        turnStartedAt = null;
        break;
      }
      case "system/thread/interrupted": {
        lastTurnEndSeq = event.seq;
        const reason = text(data.reason, 100);
        single.push({ ...base, kind: "turn", label: reason === "manual-stop" ? "Stopped by user" : "Thread interrupted", status: "interrupted", detail: reason });
        break;
      }
      case "system/error":
      case "provider/error": {
        const retry = data.willRetry === true;
        single.push({
          ...base,
          kind: retry ? "warning" : "error",
          label: (text(data.message, 200) ?? (event.type === "system/error" ? "System error" : "Provider error")) + (retry ? " (retrying)" : ""),
          detail: text(data.code, 200) ?? text(obj(data.errorInfo).category, 200),
          text: text(data.detail, OUTPUT_CAP),
        });
        break;
      }
      case "provider/warning":
        single.push({
          ...base,
          kind: "warning",
          label: oneLine(text(data.summary, 200) ?? "Provider warning", 120),
          detail: text(data.category, 100),
          text: text(data.details, OUTPUT_CAP),
        });
        break;
      case "thread/compacted": {
        // Claude Code and Pi also record a contextCompaction item for the
        // same compaction just before this; fold the two together.
        if (lastCompaction !== null && event.seq - lastCompaction.seq <= 3) {
          if (!lastCompaction.state.completed) {
            lastCompaction.state.completed = true;
            lastCompaction.state.completedAt = event.createdAt;
          }
          lastCompaction = null;
          break;
        }
        single.push({ ...base, kind: "compact", label: "Context compacted" });
        break;
      }
      case "system/operation": {
        const operation = data.operation;
        const metadata = obj(data.metadata);
        if (operation === "edit_message") {
          const from = num(metadata.cutoffSequence);
          const to = num(metadata.oldMaxSequence);
          single.push({
            ...base,
            kind: "system",
            label: "Message edited",
            status: text(data.status, 100),
            text:
              from !== null && to !== null
                ? `The edited message's original turn was replaced; events ${from + 1}\u2013${to} are no longer in this thread.`
                : "The edited message's original turn was replaced.",
          });
        } else {
          single.push({
            ...base,
            kind: "system",
            label: text(data.message, 200) ?? (typeof operation === "string" ? operation : "Operation"),
            status: text(data.status, 100),
          });
        }
        break;
      }
      case "system/interaction/lifecycle": {
        const frame = interactionFrame(base, data);
        if (frame === null) break;
        const existing = interactions.get(frame.id);
        if (existing === undefined) {
          interactions.set(frame.id, frame);
          single.push(frame);
        } else {
          // Keep the first position; take the latest status and answer.
          existing.status = frame.status;
          existing.text = frame.text ?? existing.text;
        }
        break;
      }
      default:
        break;
    }
  }

  for (const requestId of rejected) {
    const frame = userByRequest.get(requestId);
    if (frame !== undefined) frame.status = "rejected";
  }

  const itemFrames: TimeMachineFrame[] = [];
  const delegationLabels = new Map<string, string>();
  const states = [...new Set(items.values())];
  for (const state of states) {
    if (state.type === "delegation") {
      const label = text(state.item.label, 200) ?? presentationTitle(state.item);
      if (label !== null) delegationLabels.set(state.id, label);
    }
  }
  for (const state of states) {
    const frame = itemFrame(state, lastTurnEndSeq > state.seq);
    const parent = state.item.parentToolCallId;
    if (typeof parent === "string") frame.parentLabel = delegationLabels.get(parent) ?? "sub-agent";
    itemFrames.push(frame);
  }

  const frames = [...single, ...itemFrames].sort((a, b) => a.seq - b.seq);
  if (options.forkedFrom) {
    const createdAt = frames[0]?.createdAt ?? 0;
    frames.unshift({
      ...emptyFrame("fork", 0, createdAt),
      kind: "system",
      label: `Forked from ${options.forkedFrom.title ?? options.forkedFrom.threadId}`,
      detail: options.forkedFrom.threadId,
      text: "History before the fork lives in the source thread; this thread's own events start here.",
    });
  }
  return frames;
}

/** Item ids that started but never completed: their text lives only in deltas. */
export function incompleteItemSeqs(events: readonly RawEvent[]): { minSeq: number; ids: Set<string> } | null {
  const started = new Map<string, number>();
  const done = new Set<string>();
  for (const event of events) {
    if (!ITEM_UPDATE_TYPES.has(event.type)) continue;
    const id = itemIdOf(obj(event.data));
    if (id === null) continue;
    if (ITEM_COMPLETE_TYPES.has(event.type)) done.add(id);
    else if (!started.has(id) || event.seq < (started.get(id) ?? Infinity)) started.set(id, event.seq);
  }
  const ids = new Set<string>();
  let minSeq = Infinity;
  for (const [id, seq] of started) {
    if (done.has(id)) continue;
    ids.add(id);
    minSeq = Math.min(minSeq, seq);
  }
  return ids.size === 0 ? null : { minSeq, ids };
}

/** Keep only deltas for the given items, so completed items' deltas are never held. */
export function deltasFor(events: readonly RawEvent[], ids: Set<string>): RawEvent[] {
  return events.filter((event) => {
    const id = itemIdOf(obj(event.data));
    return id !== null && ids.has(id);
  });
}

/** Total characters of tool/command output sent for one thread. */
export const OUTPUT_BUDGET = 2_500_000;
const OUTPUT_KINDS = new Set(["command", "tool", "web", "read", "search", "task"]);
const MIN_PREVIEW = 600;

/**
 * Keep a huge thread's payload bounded: when command and tool output together
 * exceed the budget, shorten each output to a head-and-tail preview. Messages,
 * reasoning and diffs are left alone.
 */
export function fitOutputBudget(frames: TimeMachineFrame[], budget = OUTPUT_BUDGET): TimeMachineFrame[] {
  const outputs = frames.filter((f) => OUTPUT_KINDS.has(f.kind) && f.text !== null);
  const total = outputs.reduce((n, f) => n + (f.text?.length ?? 0), 0);
  if (total <= budget) return frames;
  const perFrame = Math.max(MIN_PREVIEW, Math.floor(budget / outputs.length));
  for (const frame of outputs) {
    const body = frame.text ?? "";
    if (body.length <= perFrame) continue;
    const half = Math.floor(perFrame / 2);
    frame.text = `${body.slice(0, half)}\n…[${body.length - 2 * half} characters omitted: long thread]…\n${body.slice(-half)}`;
  }
  return frames;
}

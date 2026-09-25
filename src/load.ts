// Read a thread's events through the SDK and build its frames.
import {
  buildFrames,
  deltasFor,
  DELTA_TYPES,
  fitOutputBudget,
  FRAME_TYPES,
  incompleteItemSeqs,
  type RawEvent,
  type TimeMachineFrame,
} from "./frames";

type EventType = (typeof FRAME_TYPES)[number] | (typeof DELTA_TYPES)[number];

/** The slice of `bb.sdk.threads` the loader uses (a fake in tests). */
export interface ThreadsReader {
  events: {
    list(args: {
      threadId: string;
      order?: "asc" | "desc";
      limit?: string;
      beforeSeq?: string;
      afterSeq?: string;
      types?: readonly [EventType, ...EventType[]];
    }): Promise<readonly unknown[]>;
  };
  get?(args: { threadId: string }): Promise<unknown>;
}

/** The events API rejects larger pages. */
export const PAGE_SIZE = 100;
/** Newest frame-bearing events kept; older history is reported as truncated. */
export const MAX_EVENTS = 40_000;
/** Delta events read to recover text of items that never completed. */
export const MAX_DELTA_EVENTS = 20_000;

function toRaw(row: unknown): RawEvent | null {
  const r = row as { seq?: unknown; type?: unknown; createdAt?: unknown; data?: unknown };
  if (typeof r.seq !== "number" || typeof r.type !== "string") return null;
  return { seq: r.seq, type: r.type, createdAt: typeof r.createdAt === "number" ? r.createdAt : 0, data: r.data };
}

async function readNewestFirst(reader: ThreadsReader, threadId: string, maxEvents: number) {
  const events: RawEvent[] = [];
  let beforeSeq: string | undefined;
  let truncated = false;
  for (;;) {
    const rows = await reader.events.list({
      threadId,
      order: "desc",
      limit: String(PAGE_SIZE),
      types: FRAME_TYPES,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    });
    for (const row of rows) {
      const raw = toRaw(row);
      if (raw !== null) events.push(raw);
    }
    const oldest = events[events.length - 1]?.seq;
    if (rows.length < PAGE_SIZE || oldest === undefined) break;
    if (events.length >= maxEvents) {
      truncated = true;
      break;
    }
    beforeSeq = String(oldest);
  }
  return { events, truncated };
}

async function readDeltas(reader: ThreadsReader, threadId: string, afterSeq: number, ids: Set<string>) {
  const kept: RawEvent[] = [];
  let cursor = afterSeq;
  let read = 0;
  while (read < MAX_DELTA_EVENTS) {
    const rows = await reader.events.list({
      threadId,
      order: "asc",
      limit: String(PAGE_SIZE),
      types: DELTA_TYPES,
      afterSeq: String(cursor),
    });
    const page = rows.map(toRaw).filter((r): r is RawEvent => r !== null);
    read += page.length;
    kept.push(...deltasFor(page, ids));
    const last = page[page.length - 1]?.seq;
    if (rows.length < PAGE_SIZE || last === undefined) break;
    cursor = last;
  }
  return kept;
}

async function forkSource(reader: ThreadsReader, threadId: string) {
  if (reader.get === undefined) return null;
  try {
    const result = (await reader.get({ threadId })) as { thread?: Record<string, unknown> } & Record<string, unknown>;
    const thread = (result.thread ?? result) as Record<string, unknown>;
    if (thread.originKind !== "fork" || typeof thread.sourceThreadId !== "string") return null;
    let title: string | null = null;
    try {
      const source = (await reader.get({ threadId: thread.sourceThreadId })) as { thread?: Record<string, unknown> } & Record<string, unknown>;
      const t = (source.thread ?? source) as Record<string, unknown>;
      title = typeof t.title === "string" ? t.title : typeof t.titleFallback === "string" ? t.titleFallback : null;
    } catch {
      // The source may be deleted; the id is enough.
    }
    return { threadId: thread.sourceThreadId, title };
  } catch {
    return null;
  }
}

export async function loadFrames(
  reader: ThreadsReader,
  threadId: string,
  options: { maxEvents?: number } = {},
): Promise<{ frames: TimeMachineFrame[]; truncated: boolean }> {
  const { events, truncated } = await readNewestFirst(reader, threadId, options.maxEvents ?? MAX_EVENTS);
  const incomplete = incompleteItemSeqs(events);
  const deltas = incomplete === null ? [] : await readDeltas(reader, threadId, incomplete.minSeq, incomplete.ids);
  const forkedFrom = truncated ? null : await forkSource(reader, threadId);
  const frames = fitOutputBudget(buildFrames([...events, ...deltas], { forkedFrom }));
  return { frames, truncated };
}

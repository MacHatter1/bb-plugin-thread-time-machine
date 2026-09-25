// bb-plugin-thread-time-machine — a BB plugin frontend entry.
//
// A sidebar nav panel that replays any thread's event history as a
// scrubbable filmstrip: drag across the timeline, press play to watch the
// session unfold, inspect any frame (messages, commands, file changes,
// errors), and select a "from" frame to see everything that changed between
// two moments as real diffs.
import { Component, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ErrorInfo, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  definePluginApp,
  experimental_Diff,
  experimental_useSidebarThreads,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";

// JSX names must start uppercase; the SDK export is a lowercase-named const.
const Diff = experimental_Diff;
import type { rpcContract, TimeMachineFrame } from "./server";
import { splitPatch } from "./src/diff";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Kind → presentation
// ---------------------------------------------------------------------------

const KIND_META: Record<string, { icon: string; dot: string; text: string; label: string }> = {
  user: { icon: "UserRound", dot: "bg-primary", text: "text-primary", label: "User message" },
  agent: { icon: "AiBrain01", dot: "bg-muted-foreground", text: "text-muted-foreground", label: "Agent message" },
  reasoning: { icon: "Brain", dot: "bg-muted-foreground/40", text: "text-muted-foreground/40", label: "Reasoning" },
  tool: { icon: "Plug02", dot: "bg-foreground/30", text: "text-foreground/30", label: "Tool call" },
  command: { icon: "AppWindow", dot: "bg-secondary-foreground/90", text: "text-secondary-foreground/90", label: "Command" },
  file: { icon: "FileDiff", dot: "bg-accent-foreground", text: "text-accent-foreground", label: "File change" },
  read: { icon: "FileText", dot: "bg-muted-foreground/60", text: "text-muted-foreground/60", label: "File read" },
  search: { icon: "ZoomIn", dot: "bg-foreground/50", text: "text-foreground/50", label: "Search" },
  web: { icon: "Globe", dot: "bg-accent", text: "text-accent", label: "Web" },
  image: { icon: "Eye", dot: "bg-primary/50", text: "text-primary/50", label: "Image" },
  task: { icon: "Beaker", dot: "bg-secondary-foreground/50", text: "text-secondary-foreground/50", label: "Task" },
  compact: { icon: "CircleArrowShrink", dot: "bg-border", text: "text-border", label: "Compaction" },
  turn: { icon: "ArrowTurnForward", dot: "bg-muted", text: "text-muted", label: "Turn" },
  error: { icon: "Limitation", dot: "bg-destructive", text: "text-destructive", label: "Error" },
  plan: { icon: "ListView", dot: "bg-primary/30", text: "text-primary/30", label: "Plan" },
  system: { icon: "Layers", dot: "bg-foreground/40", text: "text-foreground/40", label: "Thread event" },
  warning: { icon: "BellDot", dot: "bg-destructive/50", text: "text-destructive/60", label: "Warning" },
};

function kindMeta(kind: string) {
  return (
    KIND_META[kind] ?? {
      icon: "Square",
      dot: "bg-border",
      text: "text-border",
      label: "Event",
    }
  );
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

const REFRESH_CHANNEL = "thread-time-machine/changed";
const PLAY_STEP_MS = 400;
const MAX_TICKS = 800;
const MAX_AGGREGATED_DIFF = 200_000;

function useFrames(threadId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [frames, setFrames] = useState<TimeMachineFrame[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestId = useRef(0);
  const stateRef = useRef({ threadId, refetch: null as null | ((immediate?: boolean) => void) });
  stateRef.current.threadId = threadId;

  const refetch = useCallback(
    (immediate = false) => {
      if (threadId === null) return;
      const run = () => {
        const id = ++requestId.current;
        setLoading(true);
        rpc.call("timeMachine_events", { threadId }).then(
          (result) => {
            if (id !== requestId.current) return;
            setFrames(result.frames);
            setTruncated(result.truncated);
            setError(null);
            setLoading(false);
          },
          (cause) => {
            if (id !== requestId.current) return;
            setError(cause instanceof Error ? cause.message : String(cause));
            setLoading(false);
          },
        );
      };
      if (immediate) {
        if (debounce.current !== null) clearTimeout(debounce.current);
        run();
      } else {
        if (debounce.current !== null) clearTimeout(debounce.current);
        debounce.current = setTimeout(run, 600);
      }
    },
    [rpc, threadId],
  );
  stateRef.current.refetch = refetch;

  useEffect(() => {
    setFrames(null);
    setTruncated(false);
    setError(null);
    refetch(true);
    return () => {
      if (debounce.current !== null) clearTimeout(debounce.current);
    };
  }, [refetch]);

  useRealtime(REFRESH_CHANNEL, useCallback((payload: unknown) => {
    const changed = payload as { threadId?: unknown };
    const current = stateRef.current;
    if (changed.threadId === current.threadId && current.refetch !== null) {
      current.refetch(false);
    }
  }, []));

  return { frames, truncated, error, loading, refetch };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatSpan(startMs: number, endMs: number): string {
  const seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function frameTitle(thread: { title: string | null; titleFallback: string | null; id: string }) {
  return thread.title ?? thread.titleFallback ?? `thread ${thread.id.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Filmstrip
// ---------------------------------------------------------------------------

const ICON_MIN_SPACING = 20; // px between glyph centres before culling

interface FilmstripProps {
  frames: TimeMachineFrame[];
  selected: number;
  onSelect: (index: number) => void;
  markerA: number | null;
}

const Filmstrip = memo(function Filmstrip({
  frames,
  selected,
  onSelect,
  markerA,
}: FilmstripProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const scrubbing = useRef(false);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<{ index: number; left: number } | null>(
    null,
  );
  const pointerX = useRef(0);
  const rafId = useRef<number | null>(null);
  const lastApplied = useRef(selected);
  const frameLen = frames.length;
  // Frames are in event order; clamp times to never go backwards so the
  // track (and the binary search below) stays monotonic.
  const times = useMemo(() => {
    let latest = -Infinity;
    return frames.map((frame) => (latest = Math.max(latest, frame.createdAt)));
  }, [frames]);
  const start = times[0] ?? 0;
  const end = times[frameLen - 1] ?? start;
  const span = Math.max(1, end - start);

  // — measure track width for icon culling & bubble clamping —
  useEffect(() => {
    const track = trackRef.current;
    if (track === null) return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width;
      if (typeof measured === "number" && measured > 0) setWidth(measured);
    });
    observer.observe(track);
    return () => observer.disconnect();
  }, []);

  // Clean up any rAF on unmount.
  useEffect(() => {
    return () => {
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
    };
  }, []);

  // — rAF‑coalesced pointer handling —
  const applyPointer = useCallback(
    (clientX: number, commit: boolean) => {
      pointerX.current = clientX;
      if (rafId.current !== null) return;
      rafId.current = requestAnimationFrame(() => {
        rafId.current = null;
        const track = trackRef.current;
        if (track === null || frameLen === 0) return;
        const rect = track.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (pointerX.current - rect.left) / rect.width));
        // Binary‑search the nearest frame by timestamp ratio.
        let lo = 0;
        let hi = frameLen - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          const midRatio = (times[mid] - start) / span;
          if (midRatio < ratio) lo = mid + 1;
          else hi = mid;
        }
        const index = lo;
        const left = ratio * width;
        // Clamp the bubble so it stays inside the track.
        const bubbleLeft = Math.min(Math.max(left, 72), Math.max(72, width - 72));
        setHover({ index, left: bubbleLeft });
        if (commit && index !== lastApplied.current) {
          lastApplied.current = index;
          onSelect(index);
        }
      });
    },
    [times, start, span, width, frameLen, onSelect],
  );

  // When the parent resets selected outside of drag (load, play step, arrow
  // keys), keep our dedup tracker in sync.
  lastApplied.current = selected;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    scrubbing.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    applyPointer(event.clientX, true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    applyPointer(event.clientX, scrubbing.current);
  };
  const endScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!scrubbing.current) return;
    scrubbing.current = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
    applyPointer(event.clientX, true);
  };
  const onPointerLeave = () => {
    if (!scrubbing.current) setHover(null);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onSelect(Math.max(0, selected - 1));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onSelect(Math.min(frameLen - 1, selected + 1));
    }
  };

  // — sampled data (cheap, memoised) —
  const stride = Math.max(1, Math.ceil(frameLen / MAX_TICKS));

  const ticks = useMemo(() => {
    const result: { index: number; ratio: number }[] = [];
    for (let index = 0; index < frameLen; index += stride) {
      result.push({ index, ratio: (times[index] - start) / span });
    }
    return result;
  }, [times, start, span, stride, frameLen]);

  const icons = useMemo(() => {
    const result: { index: number; left: number }[] = [];
    let lastLeft = -ICON_MIN_SPACING;
    for (let index = 0; index < frameLen; index += stride) {
      const ratio = (times[index] - start) / span;
      const left = Math.max(10, Math.min(width - 10, ratio * width));
      if (left - lastLeft >= ICON_MIN_SPACING) {
        result.push({ index, left });
        lastLeft = left;
      }
    }
    return result;
  }, [times, start, span, stride, width, frameLen]);

  // Pre‑rendered tick & icon elements.
  const ticksEl = useMemo(
    () =>
      ticks.map(({ index, ratio }) => (
        <span
          key={`tick-${index}`}
          aria-hidden
          className={cn(
            "absolute bottom-[7px] h-3 w-[2px] -translate-x-1/2 rounded-full",
            kindMeta(frames[index].kind).dot,
          )}
          style={{ left: `${ratio * 100}%` }}
        />
      )),
    [ticks, frames],
  );

  const iconsEl = useMemo(
    () =>
      icons.map(({ index, left }) => {
        const meta = kindMeta(frames[index].kind);
        return (
          <span
            key={`icon-${index}`}
            className={cn(
              "absolute top-[7px] -translate-x-1/2",
              index === selected && "opacity-30",
            )}
            style={{ left }}
            title={`${frames[index].label} · ${formatTime(frames[index].createdAt)}`}
          >
            <Icon name={meta.icon} className={cn("size-3.5", meta.text)} />
          </span>
        );
      }),
    [icons, selected, frames],
  );

  const selectedRatio = ((times[selected] ?? start) - start) / span;
  const markerRatio = markerA === null ? null : ((times[markerA] ?? start) - start) / span;

  const presentKinds = useMemo(() => {
    const seen = new Set<string>();
    for (const frame of frames) seen.add(frame.kind);
    return [...seen].sort();
  }, [frames]);

  return (
    <div>
      <div
        ref={trackRef}
        role="slider"
        aria-label="Thread timeline scrubber"
        aria-valuemin={0}
        aria-valuemax={frameLen - 1}
        aria-valuenow={selected}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
        onPointerLeave={onPointerLeave}
        onKeyDown={onKeyDown}
        className="relative h-11 w-full cursor-ew-resize touch-none select-none rounded-md border border-border bg-muted/40 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {ticksEl}
        {iconsEl}
        {markerRatio !== null ? (
          <span
            aria-hidden
            className="pointer-events-none absolute top-1/2 h-10 w-[3px] -translate-y-1/2 rounded-full bg-primary/90"
            style={{ left: `${markerRatio * 100}%` }}
          />
        ) : null}
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 z-10 h-11 w-1 -translate-y-1/2 rounded-full bg-foreground shadow-[0_0_0_1px_var(--color-background)]"
          style={{ left: `${selectedRatio * 100}%` }}
        />
        {/* Hover preview bubble */}
        {hover !== null ? (
          <span
            className="pointer-events-none absolute z-20 -top-7 max-w-[140px] truncate rounded border border-border bg-background px-1.5 py-0.5 text-[10px] leading-tight text-muted-foreground shadow-sm"
            style={{ left: hover.left, transform: "translateX(-50%)" }}
          >
            {formatTime(frames[hover.index].createdAt)} ·{" "}
            {frames[hover.index].label.slice(0, 28)}
          </span>
        ) : null}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{formatTime(start)}</span>
        <span>{formatSpan(start, end)}</span>
        <span>{formatTime(end)}</span>
      </div>
      {presentKinds.length > 1 ? (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
          {presentKinds.map((kind) => {
            const meta = kindMeta(kind);
            return (
              <span
                key={kind}
                className="flex items-center gap-1 text-[10px] text-muted-foreground"
              >
                <Icon name={meta.icon} className={cn("size-3", meta.text)} />
                {meta.label}
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Frame inspector
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return formatSpan(0, ms);
}

function DiffBlock({ path, patch, kind }: { path: string; patch: string; kind: "add" | "delete" | "update" }) {
  // Providers store diffs in several shapes; render all of them as one-file
  // unified patches, one per old/new pair the edit holds (see src/diff.ts).
  const parts = useMemo(() => splitPatch(patch, path, kind), [patch, path, kind]);
  const normalized = useMemo(
    () => ({
      added: parts.reduce((n, p) => n + p.added, 0),
      removed: parts.reduce((n, p) => n + p.removed, 0),
      size: parts.reduce((n, p) => n + p.patch.length, 0),
      synthetic: parts.some((p) => p.synthetic),
      truncated: parts.some((p) => p.truncated),
    }),
    [parts],
  );
  const [open, setOpen] = useState(normalized.size < 8_000);

  return (
    <div className="overflow-hidden rounded-md border border-border bg-background">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 bg-muted/40 px-2.5 py-1.5 text-left text-xs text-foreground hover:bg-muted/70"
      >
        <Icon name="FileDiff" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono">
          {path.split("/").pop() ?? path}
        </span>
        {normalized.added > 0 || normalized.removed > 0 ? (
          <span className="shrink-0 text-muted-foreground">
            {normalized.added > 0 ? `+${normalized.added}` : ""}
            {normalized.added > 0 && normalized.removed > 0 ? " / " : ""}
            {normalized.removed > 0 ? `\u2212${normalized.removed}` : ""}
          </span>
        ) : null}
        <span className="shrink-0 text-muted-foreground">
          {open ? "collapse" : `${Math.ceil(normalized.size / 1024)} KB`}
        </span>
      </button>
      {open ? (
        <div className="max-h-80 overflow-auto border-t border-border bg-background">
          {parts.map((part, index) => (
            <div key={index} className={cn(index > 0 && "border-t border-border")}>
              {parts.length > 1 ? (
                <p className="bg-muted/30 px-2.5 py-1 text-[11px] text-muted-foreground">
                  Change {index + 1} of {parts.length}
                </p>
              ) : null}
              <Diff
                patch={part.patch}
                path={path}
                view="unified"
                showLineNumbers={!part.synthetic}
                overflow="wrap"
              />
            </div>
          ))}
          {normalized.synthetic || normalized.truncated ? (
            <p className="border-t border-border px-2.5 py-1 text-[11px] text-muted-foreground">
              {normalized.truncated ? "Diff cut short; only the start is shown. " : ""}
              {normalized.synthetic ? "The provider stored this edit without line numbers." : ""}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function FrameInspector({ frame }: { frame: TimeMachineFrame }) {
  const meta = kindMeta(frame.kind);
  // "completed" is the norm; only call out other states.
  const kindText = frame.status !== null && frame.status !== "completed" ? frame.status : null;
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md",
            meta.dot,
          )}
        >
          <Icon name={meta.icon} className="size-4 text-background" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm font-medium">{frame.label}</span>
            <span className="text-xs text-muted-foreground">
              {formatTime(frame.createdAt)}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {meta.label}
            {frame.path !== null ? ` · ${frame.path}` : ""}
            {kindText !== null ? ` · ${kindText}` : ""}
            {frame.durationMs !== null ? ` · ${formatDuration(frame.durationMs)}` : ""}
            {frame.exitCode !== null ? (
              <span className={cn(frame.exitCode === 0 ? "" : "text-destructive")}>
                {" "}
                · exit {frame.exitCode}
              </span>
            ) : null}
          </p>
          {frame.parentLabel !== null ? (
            <p className="mt-1 inline-flex max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              <Icon name="CornerDownRight" className="size-3 shrink-0" />
              <span className="truncate">in sub-agent: {frame.parentLabel}</span>
            </p>
          ) : null}
        </div>
      </div>

      {frame.detail !== null && frame.detail !== "" ? (
        <pre className="mt-2.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/20 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground">
          {frame.detail}
        </pre>
      ) : null}

      {frame.command !== null ? (
        <pre className="mt-2.5 overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/50 px-2.5 py-2 font-mono text-xs">
          $ {frame.command}
        </pre>
      ) : null}

      {frame.text !== null && frame.text !== "" ? (
        <pre className="mt-2.5 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 px-2.5 py-2 text-xs">
          {frame.text}
        </pre>
      ) : null}

      {frame.changes.length > 0 ? (
        <div className="mt-2.5 space-y-1.5">
          {frame.changes.map((change, index) => (
            <div key={`${change.path}-${index}`} className="space-y-1.5">
              <p className="flex items-center gap-2 px-0.5 text-xs">
                <span
                  className={cn(
                    "rounded px-1 font-mono text-[10px] uppercase tracking-wide",
                    change.kind === "add" && "bg-primary/15 text-primary",
                    change.kind === "delete" && "bg-destructive/15 text-destructive",
                    change.kind === "update" && "bg-muted text-muted-foreground",
                  )}
                >
                  {change.kind}
                </span>
                <span className="min-w-0 truncate font-mono">{change.path}</span>
                {change.movePath !== null ? (
                  <span className="truncate text-muted-foreground">
                    ← {change.movePath}
                  </span>
                ) : null}
              </p>
              {change.diff !== null ? (
                <DiffBlock path={change.path} patch={change.diff} kind={change.kind} />
              ) : (
                <p className="pl-5 text-[11px] text-muted-foreground">
                  change recorded; diff not stored by the provider
                </p>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// From/To aggregate diff
// ---------------------------------------------------------------------------

interface RangeFile {
  path: string;
  kinds: Set<string>;
  /** One entry per change, oldest first; the diff viewer takes one patch at a time. */
  patches: { key: string; patch: string; kind: "add" | "delete" | "update" }[];
  missing: number;
  truncated: boolean;
}

/** File changes after frame `from`, up to and including frame `to`. */
function aggregateDiff(frames: TimeMachineFrame[], from: number, to: number) {
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const byPath = new Map<string, RangeFile>();
  let totalChanges = 0;
  let size = 0;
  for (let index = lo + 1; index <= hi; index += 1) {
    frames[index].changes.forEach((change, changeIndex) => {
      totalChanges += 1;
      let entry = byPath.get(change.path);
      if (entry === undefined) {
        entry = { path: change.path, kinds: new Set(), patches: [], missing: 0, truncated: false };
        byPath.set(change.path, entry);
      }
      entry.kinds.add(change.kind);
      if (change.diff === null) entry.missing += 1;
      else if (size + change.diff.length > MAX_AGGREGATED_DIFF) entry.truncated = true;
      else {
        size += change.diff.length;
        entry.patches.push({ key: `${frames[index].id}:${changeIndex}`, patch: change.diff, kind: change.kind });
      }
    });
  }
  return { files: [...byPath.values()], totalChanges };
}

function RangeDiffView({
  frames,
  from,
  to,
}: {
  frames: TimeMachineFrame[];
  from: number;
  to: number;
}) {
  const { files, totalChanges } = useMemo(
    () => aggregateDiff(frames, from, to),
    [frames, from, to],
  );
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{totalChanges}</span> change
        {totalChanges === 1 ? "" : "s"} across{" "}
        <span className="font-medium text-foreground">{files.length}</span> file
        {files.length === 1 ? "" : "s"} between the marked frame and the
        current one.
      </p>
      {files.map((file) => (
        <div key={file.path} className="space-y-1.5">
          <p className="flex items-center gap-2 px-0.5 text-xs">
            <span className="rounded bg-muted px-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {[...file.kinds].join(", ")}
            </span>
            <span className="min-w-0 truncate font-mono">{file.path}</span>
            {file.patches.length > 1 ? (
              <span className="ml-auto shrink-0 text-muted-foreground">
                {file.patches.length} edits, in order
              </span>
            ) : null}
          </p>
          {file.patches.map((entry) => (
            <DiffBlock key={entry.key} path={file.path} patch={entry.patch} kind={entry.kind} />
          ))}
          {file.missing > 0 || file.truncated ? (
            <p className="pl-5 text-[11px] text-muted-foreground">
              {file.missing > 0
                ? `${file.missing} change${file.missing === 1 ? "" : "s"} recorded without a diff by the provider. `
                : ""}
              {file.truncated ? "More edits omitted: the range is too large to show every diff." : ""}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Crash containment
// ---------------------------------------------------------------------------

class PanelBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: Error): { error: string } {
    return { error: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("thread-time-machine panel error", error, info);
  }

  render() {
    if (this.state.error !== null) {
      return (
        <div className="h-full min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto box-border w-full max-w-3xl px-4 pb-6 pt-3 md:px-5 md:pt-4">
            <div
              role="alert"
              className="rounded-lg border border-dashed border-destructive/50 px-4 py-6 text-sm text-destructive"
            >
              The Time Machine panel hit an error: {this.state.error}
              <p className="mt-2 text-xs text-muted-foreground">
                Reload the plugin (
                <code>bb plugin reload thread-time-machine</code>) to retry.
              </p>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function TimeMachinePage() {
  const sidebar = experimental_useSidebarThreads();
  const bbContext = useBbContext();
  const navigate = useBbNavigate();
  const threads = useMemo(
    () =>
      [...(sidebar.threads ?? [])]
        .filter((thread) => !thread.isArchived)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sidebar.threads],
  );
  const [threadId, setThreadId] = useState<string | null>(bbContext.threadId);
  // Hidden threads (workers, sub-agents, probes) are not in the sidebar list;
  // an id typed here is kept even though the picker cannot show it.
  const [typedId, setTypedId] = useState("");
  const [pinnedId, setPinnedId] = useState<string | null>(bbContext.threadId);
  const { frames, truncated, error, loading, refetch } = useFrames(threadId);
  const [selected, setSelected] = useState(0);
  const [markerA, setMarkerA] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const playTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reset on thread switch.
  useEffect(() => {
    setSelected(frames !== null ? Math.max(0, frames.length - 1) : 0);
    setMarkerA(null);
    setPlaying(false);
  }, [threadId, frames === null]);

  // Live: if the last frame was selected when new frames arrive, follow them.
  const lastCount = useRef(0);
  useEffect(() => {
    if (frames === null) {
      lastCount.current = 0;
      return;
    }
    const previous = lastCount.current;
    lastCount.current = frames.length;
    if (previous > 0 && frames.length > previous) {
      setSelected((value) => (value >= previous - 1 ? frames.length - 1 : value));
    }
  }, [frames]);

  // -----------------------------------------------------------
  // Debounced "settled" selection — the heavy inspector & range-
  // diff view use this so they don't remount on every drag tick.
  // The filmstrip and frame counter stay live.
  // -----------------------------------------------------------
  const [settled, setSettled] = useState(0);
  useEffect(() => {
    // apply live value instantly on first paint, then trail by 140 ms
    const timer = setTimeout(() => setSettled(selected), selected === settled ? 0 : 140);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // Clamped safe values
  const frameCount = frames?.length ?? 0;
  const safeSelected = frameCount === 0 ? 0 : Math.min(selected, frameCount - 1);
  const safeMarkerA =
    markerA !== null && markerA < frameCount && frameCount > 0 ? markerA : null;
  const settledIndex = frameCount === 0 ? 0 : Math.min(settled, frameCount - 1);
  const settledFrame =
    frames !== null && frameCount > 0 ? frames[settledIndex] : null;

  // Playback: step forward until the end of the filmstrip.
  useEffect(() => {
    if (!playing) return;
    if (frames === null) return;
    if (selected > frames.length - 1) {
      setSelected(frames.length - 1);
      return;
    }
    if (selected >= frames.length - 1) {
      setPlaying(false);
      return;
    }
    playTimer.current = setInterval(() => {
      setSelected((value) => {
        if (frames !== null && value >= frames.length - 1) {
          setPlaying(false);
          return value;
        }
        return value + 1;
      });
    }, PLAY_STEP_MS);
    return () => {
      if (playTimer.current !== null) clearInterval(playTimer.current);
    };
  }, [playing, frames, selected]);

  const selectedThread =
    threads.find((thread) => thread.id === threadId) ?? null;

  // Auto-pick a thread.
  useEffect(() => {
    if (threads.length === 0) return;
    if (threadId !== null && (threadId === pinnedId || threads.some((thread) => thread.id === threadId))) {
      return;
    }
    const preferred =
      threads.find((thread) => thread.id === bbContext.threadId) ?? threads[0];
    setThreadId(preferred.id);
  }, [threads, threadId, pinnedId, bbContext.threadId]);

  // Files touched up to the settled frame (cheap on settled; heavy on drag).
  const filesTouched = useMemo(() => {
    if (frames === null) return 0;
    const paths = new Set<string>();
    for (let index = 0; index <= settledIndex; index += 1) {
      for (const change of frames[index].changes) paths.add(change.path);
    }
    return paths.size;
  }, [frames, settledIndex]);

  return (
    <PanelBoundary>
      <div className="h-full min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto box-border w-full max-w-3xl px-4 pb-6 pt-3 md:px-5 md:pt-4">
          <p className="text-sm text-muted-foreground">
            Replay any thread frame by frame: every message, command, file
            change and error, with a diff between any two moments.
          </p>

          {/* Thread picker */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select
              aria-label="Thread to replay"
              value={threadId ?? ""}
              onChange={(event) => {
                setPinnedId(null);
                setThreadId(event.target.value || null);
              }}
              disabled={sidebar.status !== "ready" || threads.length === 0}
              className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              {threadId !== null && selectedThread === null ? (
                <option value={threadId}>{threadId}</option>
              ) : null}
              {threads.length === 0 ? (
                <option value="">No threads in the sidebar</option>
              ) : (
                threads.map((thread) => (
                  <option key={thread.id} value={thread.id}>
                    {frameTitle(thread)}
                  </option>
                ))
              )}
            </select>
            <form
              className="w-40"
              onSubmit={(event) => {
                event.preventDefault();
                const id = typedId.trim();
                if (id === "") return;
                setPinnedId(id);
                setThreadId(id);
                setTypedId("");
              }}
            >
              <Input
                aria-label="Replay a thread by id"
                placeholder="or thread id…"
                value={typedId}
                onChange={(event) => setTypedId(event.target.value)}
                className="h-8 font-mono text-xs"
              />
            </form>
            <Button
              variant="outline"
              size="sm"
              aria-label="Refresh filmstrip"
              disabled={threadId === null || loading}
              onClick={() => refetch(true)}
            >
              <Icon
                name="ArrowReloadHorizontal"
                className={cn("size-4", loading && "animate-spin")}
              />
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-label="Open this thread"
              disabled={threadId === null}
              onClick={() => threadId !== null && navigate.toThread(threadId)}
            >
              <Icon name="ExternalLink" className="size-4" />
              Open
            </Button>
          </div>

          {threadId === null ? (
            <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              Choose a thread above to start replaying.
            </div>
          ) : sidebar.status === "loading" || (frames === null && !error) ? (
            <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              Loading the session…
            </div>
          ) : error !== null ? (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-dashed border-destructive/50 px-4 py-6 text-center text-sm text-destructive"
            >
              Could not replay this thread: {error}
            </div>
          ) : frames === null || frames.length === 0 ? (
            <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              Nothing to replay yet — this thread has no recorded events. Start
              a conversation in it, then come back.
            </div>
          ) : (
            <>
              {/* Filmstrip */}
              <div className="mt-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-medium">
                    {selectedThread !== null
                      ? frameTitle(selectedThread)
                      : threadId}
                  </p>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label="Mark this frame as the start of a diff"
                      onClick={() => setMarkerA(safeSelected)}
                    >
                      <span title="Set start (A) — diff from here to the current frame">
                        <Icon name="Pin" className="size-4" />
                      </span>
                    </Button>
                    {markerA !== null ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label="Clear the start marker"
                        onClick={() => setMarkerA(null)}
                      >
                        <span title="Clear start marker">
                          <Icon name="PinOff" className="size-4" />
                        </span>
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={playing ? "Pause playback" : "Play the session"}
                      onClick={() => setPlaying((value) => !value)}
                    >
                      <Icon
                        name={playing ? "Pause" : "Play"}
                        className="size-4"
                      />
                    </Button>
                  </div>
                </div>
                <Filmstrip
                  frames={frames}
                  selected={safeSelected}
                  onSelect={setSelected}
                  markerA={safeMarkerA}
                />
                <p className="text-xs text-muted-foreground">
                  frame {safeSelected + 1} / {frames.length} · {filesTouched}{" "}
                  file
                  {filesTouched === 1 ? "" : "s"} touched so far
                  {truncated ? " · oldest history omitted" : ""}
                </p>
              </div>

              {/* From/To diff — uses settled to avoid recompute on drag */}
              {frames !== null && safeMarkerA !== null ? (
                <div className="mt-4 rounded-lg border border-primary/40 bg-primary/5 p-3">
                  <p className="mb-2 flex items-center gap-2 text-xs font-medium text-primary">
                    <Icon name="Pin" className="size-3.5" />
                    Range diff: frame {safeMarkerA + 1}{" "}
                    <span className="text-muted-foreground">
                      ({formatTime(frames[safeMarkerA].createdAt)})
                    </span>
                    <span>→</span> frame {settledIndex + 1}{" "}
                    <span className="text-muted-foreground">
                      ({formatTime(frames[settledIndex].createdAt)})
                    </span>
                  </p>
                  <RangeDiffView
                    frames={frames}
                    from={safeMarkerA}
                    to={settledIndex}
                  />
                </div>
              ) : (
                <p className="mt-4 text-xs text-muted-foreground">
                  Tip: pin the current frame with{" "}
                  <Icon name="Pin" className="inline size-3 align-[-1px]" /> to
                  see everything that changed between two moments as a diff.
                </p>
              )}

              {/* Inspector — bound to settled, so diff blocks don't remount
                  every drag tick. The filmstrip + counter stay live. */}
              <div className="mt-4 space-y-2.5">
                {settledFrame !== null ? (
                  <FrameInspector
                    key={settledFrame.id}
                    frame={settledFrame}
                  />
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </PanelBoundary>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "time-machine",
    title: "Time Machine",
    icon: "TimeSchedule",
    path: "time-machine",
    component: TimeMachinePage,
  });
});
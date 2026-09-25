// bb-plugin-thread-time-machine — a BB plugin backend entry.
//
// Serves one RPC (a thread's frames) and one CLI command, and forwards
// `thread:changed` so an open panel refreshes while an agent works.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { parseDumpArgs, renderDump, renderJson } from "./src/cli";
import { frameSchema } from "./src/frames";
import { loadFrames } from "./src/load";

export { frameSchema, type TimeMachineFrame } from "./src/frames";

export const rpcContract = defineRpcContract({
  timeMachine_events: {
    input: z.object({ threadId: z.string().min(1).max(200) }),
    output: z.object({ frames: z.array(frameSchema), truncated: z.boolean() }),
  },
});

export const THREAD_CHANGED = "thread-time-machine/changed";

export default async function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    timeMachine_events: ({ threadId }) => loadFrames(bb.sdk.threads, threadId),
  });

  const unsubscribe = bb.sdk.subscribe({
    event: "thread:changed",
    callback: (event) => {
      if (event.id) bb.realtime.publish(THREAD_CHANGED, { threadId: event.id });
    },
  });

  bb.cli.register({
    name: "thread-time-machine",
    summary: "Replay a thread's event history as a condensed timeline",
    commands: [
      {
        name: "dump",
        summary: "Print a thread's event history",
        usage: "bb thread-time-machine dump <thread-id> [--json] [--limit <n>]",
      },
    ],
    async run(argv) {
      const args = parseDumpArgs(argv);
      if ("error" in args) return { exitCode: 1, stderr: args.error };
      try {
        const { frames, truncated } = await loadFrames(bb.sdk.threads, args.threadId);
        if (args.json) {
          const { stdout, omitted } = renderJson(frames, args.limit);
          const note = omitted > 0 ? `${omitted} older frames omitted to fit the 1 MB CLI output limit.\n` : "";
          return { exitCode: 0, stdout, ...(note === "" ? {} : { stderr: note }) };
        }
        return { exitCode: 0, stdout: renderDump(frames, args.limit, truncated) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { exitCode: 1, stderr: `Failed to read thread ${args.threadId}: ${message}` };
      }
    },
  });

  bb.onDispose(unsubscribe);
}

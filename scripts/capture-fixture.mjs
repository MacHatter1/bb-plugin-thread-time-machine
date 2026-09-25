#!/usr/bin/env node
// Capture a real thread's events as a scrubbed test fixture.
//
//   node scripts/capture-fixture.mjs <thread-id> <name> [--from <seq>] [--to <seq>]
//        [--max-deltas <n>] [--note <text>] [--redact <text>]...
//
// Writes test/fixtures/<name>.json. Only the event types the plugin reads are
// kept; home directories, emails, tokens and long base64 blobs are replaced,
// and long strings are shortened (shapes are what the tests care about).
// Each --redact text (case-insensitive, e.g. a private project name) becomes
// "acme".
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const USER = os.userInfo().username;

const KEEP = new Set([
  "item/started", "item/completed", "item/backgroundTask/progress", "item/backgroundTask/completed",
  "item/delegation/completed", "client/turn/requested", "client/turn/rejected", "turn/started",
  "turn/completed", "system/thread/interrupted", "system/error", "provider/error", "provider/warning",
  "thread/compacted", "system/operation", "system/interaction/lifecycle",
]);
const DELTAS = new Set([
  "item/agentMessage/delta", "item/reasoning/textDelta", "item/reasoning/summaryTextDelta",
  "item/commandExecution/outputDelta", "item/fileChange/outputDelta",
]);
const STRING_LIMIT = 3000;

const [threadId, name, ...rest] = process.argv.slice(2);
if (!threadId || !name) {
  console.error("usage: capture-fixture.mjs <thread-id> <name> [--from <seq>] [--to <seq>] [--max-deltas <n>] [--note <text>]");
  process.exit(1);
}
const flag = (key, fallback) => {
  const index = rest.indexOf(key);
  return index >= 0 ? rest[index + 1] : fallback;
};
const from = Number(flag("--from", "0"));
const to = Number(flag("--to", String(Number.MAX_SAFE_INTEGER)));
const maxDeltas = Number(flag("--max-deltas", "400"));
const note = flag("--note", "");
const redactions = rest
  .flatMap((arg, index) => (arg === "--redact" ? [rest[index + 1]] : []))
  .map((text) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"));

export function scrubString(value) {
  let s = value
    .replace(/\/(Users|home)\/[^/\s"'`\\]+/g, "/$1/dev")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "user@example.com")
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "$1-[redacted]")
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, "$1_[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_[redacted]")
    .replace(/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, "xox-[redacted]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[jwt redacted]")
    .replace(/\b(Bearer|token|Token)\s+[A-Za-z0-9._~+/-]{20,}=*/g, "$1 [redacted]")
    .replace(/([?&](?:client_id|client_secret|code|token|access_token|key|api_key|state)=)[^&\s"']+/g, "$1[redacted]")
    .replace(/[A-Za-z0-9+/]{200,}={0,2}/g, "[base64 redacted]");
  if (USER.length >= 3) s = s.split(USER).join("dev");
  for (const pattern of redactions) s = s.replace(pattern, "acme");
  if (s.length > STRING_LIMIT) s = s.slice(0, STRING_LIMIT) + "\n…[fixture truncated]";
  return s;
}

function scrub(value) {
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  }
  return value;
}

const raw = execFileSync("bb", ["thread", "log", threadId, "--json", "--all"], {
  encoding: "utf8",
  maxBuffer: 1024 * 1024 * 1024,
});
const all = JSON.parse(raw);
const show = JSON.parse(execFileSync("bb", ["thread", "show", threadId, "--json"], { encoding: "utf8" }));
let deltaCount = 0;
const events = [];
for (const event of all) {
  if (event.seq < from || event.seq > to) continue;
  if (DELTAS.has(event.type)) {
    if (deltaCount >= maxDeltas) continue;
    deltaCount += 1;
  } else if (!KEEP.has(event.type)) continue;
  events.push({ seq: event.seq, type: event.type, createdAt: event.createdAt, data: scrub(event.data) });
}

const out = path.join(import.meta.dirname, "..", "test", "fixtures", `${name}.json`);
const thread = show.thread ?? show;
writeFileSync(
  out,
  JSON.stringify(
    { providerId: thread.providerId, threadId, originKind: thread.originKind ?? null, note, events },
    null,
    1,
  ) + "\n",
);
console.log(`${out}: ${events.length} events (${deltaCount} deltas) from ${all.length}`);

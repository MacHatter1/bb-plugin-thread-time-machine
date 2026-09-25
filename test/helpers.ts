import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { RawEvent } from "../src/frames";

export interface Fixture {
  providerId: string;
  threadId: string;
  originKind: string | null;
  note: string;
  events: RawEvent[];
}

const DIR = path.join(import.meta.dirname, "fixtures");

export const FIXTURE_NAMES = readdirSync(DIR)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.slice(0, -".json".length))
  .sort();

export function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(path.join(DIR, `${name}.json`), "utf8")) as Fixture;
}

/** Item ids that appear in item lifecycle events. */
export function itemIds(events: readonly RawEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (!event.type.startsWith("item/")) continue;
    const data = event.data as { itemId?: unknown; item?: { id?: unknown } };
    const id = typeof data.itemId === "string" ? data.itemId : data.item?.id;
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}

let seq = 0;
/** A synthetic event for focused tests. */
export function ev(type: string, data: unknown, createdAt = 1_000_000 + seq * 1000): RawEvent {
  seq += 1;
  return { seq, type, createdAt, data };
}

import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { PiRpcError, piRecordField, piRecordString, type PiRpcRecord } from "./rpc.ts";

export const readPiEntries = <E>(
  paged: boolean,
  request: (input: PiRpcRecord) => Effect.Effect<unknown, E>,
  since?: string,
): Effect.Effect<unknown, E | PiRpcError> => {
  if (!paged) return request({ type: "get_entries", ...(since === undefined ? {} : { since }) });
  return Effect.gen(function* () {
    const entries: unknown[] = [];
    const seen = new Set<string>();
    let cursor = since;
    let leafId: unknown = null;
    for (let page = 0; page < 256; page++) {
      const data = yield* request({
        type: "get_entries",
        ...(cursor === undefined ? {} : { since: cursor }),
        limit: 500,
        maxBytes: 4 * 1024 * 1024,
      });
      const batch = piRecordField(data, "entries");
      const hasMore = piRecordField(data, "hasMore");
      leafId = piRecordField(data, "leafId");
      if (!Array.isArray(batch) || typeof hasMore !== "boolean") {
        return yield* new PiRpcError({
          operation: "get_entries",
          detail: "Invalid paged response",
        });
      }
      entries.push(...batch);
      if (!hasMore) return { entries, leafId };
      const next = piRecordString(data, "nextSince");
      if (next === undefined || next === cursor || seen.has(next) || batch.length === 0) {
        return yield* new PiRpcError({
          operation: "get_entries",
          detail: "Page cannot advance; an entry may exceed the size limit",
        });
      }
      seen.add(next);
      cursor = next;
    }
    return yield* new PiRpcError({
      operation: "get_entries",
      detail: "History exceeds the page limit",
    });
  });
};

interface PiSessionEntry {
  readonly parentId: string | null;
  readonly isUserMessage: boolean;
  /** Pi's `timestamp` as epoch milliseconds; null when missing or unparsable. */
  readonly timestamp: number | null;
}

export interface PiSessionListing {
  readonly entries: ReadonlyMap<string, PiSessionEntry>;
  readonly leafId: string | null;
}

export function piSessionListing(data: unknown): PiSessionListing | null {
  const leafId = piRecordField(data, "leafId");
  const entries = piSessionEntries(piRecordField(data, "entries"));
  return entries !== null && (typeof leafId === "string" || leafId === null)
    ? { entries, leafId }
    : null;
}

function piSessionEntries(entries: unknown): ReadonlyMap<string, PiSessionEntry> | null {
  const byId = new Map<string, PiSessionEntry>();
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    const id = piRecordString(entry, "id");
    const parentId = piRecordField(entry, "parentId");
    if (id === undefined || byId.has(id) || (parentId !== null && typeof parentId !== "string"))
      return null;
    const timestamp = piRecordString(entry, "timestamp");
    byId.set(id, {
      parentId,
      isUserMessage:
        piRecordField(entry, "type") === "message" &&
        piRecordString(piRecordField(entry, "message"), "role") === "user",
      timestamp:
        timestamp === undefined
          ? null
          : Option.getOrNull(Option.map(DateTime.make(timestamp), DateTime.toEpochMillis)),
    });
  }
  return byId;
}

export function walkPiBranch(
  entries: ReadonlyMap<string, PiSessionEntry>,
  leafId: string | null,
  stopAt: string | null,
): {
  readonly entryCount: number;
  readonly userEntryIds: ReadonlyArray<string>;
  readonly reachedStop: boolean;
} | null {
  const visited = new Set<string>();
  const userEntryIds: Array<string> = [];
  let current = leafId;
  while (current !== null && current !== stopAt) {
    const entry = entries.get(current);
    if (entry === undefined) break;
    if (visited.has(current)) return null;
    visited.add(current);
    if (entry.isUserMessage) userEntryIds.push(current);
    current = entry.parentId;
  }
  return { entryCount: visited.size, userEntryIds, reachedStop: current === stopAt };
}

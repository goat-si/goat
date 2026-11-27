import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { PiRpcError, piRecordField, piRecordString, type PiRpcRecord } from "./rpc.ts";

const decodeSessionLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

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

export interface PiSessionEntry {
  readonly parentId: string | null;
  readonly isUserMessage: boolean;
  readonly isLabel: boolean;
  /** Pi's `timestamp` as epoch milliseconds; null when missing or unparsable. */
  readonly timestamp: number | null;
}

export interface PiSessionListing {
  readonly entries: ReadonlyMap<string, PiSessionEntry>;
  readonly leafId: string | null;
}

export function readPiSessionEntry(entry: unknown): [string, PiSessionEntry] | null {
  const id = piRecordString(entry, "id");
  const parentId = piRecordField(entry, "parentId");
  if (id === undefined || (parentId !== null && typeof parentId !== "string")) return null;
  const timestamp = piRecordString(entry, "timestamp");
  return [
    id,
    {
      parentId,
      isUserMessage:
        piRecordField(entry, "type") === "message" &&
        piRecordString(piRecordField(entry, "message"), "role") === "user",
      isLabel: piRecordField(entry, "type") === "label",
      timestamp:
        timestamp === undefined
          ? null
          : Option.getOrNull(Option.map(DateTime.make(timestamp), DateTime.toEpochMillis)),
    },
  ];
}

export const readPiSessionFile = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  file: string,
): Effect.fn.Return<PiSessionListing | null> {
  const entries = new Map<string, PiSessionEntry>();
  let leafId: string | null = null;
  const readable = yield* fileSystem.stream(file).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) =>
      Effect.sync(() => {
        const entry = readPiSessionEntry(Option.getOrUndefined(decodeSessionLine(line)));
        if (entry === null) return;
        const [id, value] = entry;
        entries.set(id, value);
        leafId = id;
      }),
    ),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  return readable ? { entries, leafId } : null;
});

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
    const parsed = readPiSessionEntry(entry);
    if (parsed === null || byId.has(parsed[0])) return null;
    byId.set(parsed[0], parsed[1]);
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

export function piUserEntryInWindow(
  entry: PiSessionEntry | undefined,
  from: number,
  to: number,
): boolean {
  return (
    entry?.isUserMessage === true &&
    entry.timestamp !== null &&
    entry.timestamp >= from &&
    entry.timestamp <= to
  );
}

export interface PiRetainedCheckpoint {
  readonly headId: string;
  readonly forkEntryId?: string;
}

export interface PiHistoricalCheckpoint {
  readonly file: string;
  readonly listing: PiSessionListing;
  readonly retained: PiRetainedCheckpoint;
}

export function piRetainedCheckpoint(
  listing: PiSessionListing,
  targetId: string,
  completedAt: number | undefined,
): PiRetainedCheckpoint | undefined {
  const walk = walkPiBranch(listing.entries, listing.leafId, targetId);
  if (listing.leafId === null || walk?.reachedStop !== true || !listing.entries.has(targetId))
    return undefined;
  // An extension can leave later prompts in the source. Keep steers within the retained turn.
  for (const id of [...walk.userEntryIds].reverse()) {
    const entry = listing.entries.get(id);
    if (entry?.timestamp == null || completedAt === undefined) return undefined;
    if (entry.timestamp >= completedAt)
      return entry.parentId === null ? undefined : { headId: entry.parentId, forkEntryId: id };
  }
  return { headId: listing.leafId };
}

// Pi's fork drops label entries from the copied path and re-adds them with new ids at the leaf.
export function piSameHistory(
  a: PiSessionListing,
  aHead: string | null,
  b: PiSessionListing,
  bHead: string | null,
): boolean {
  const aPath = piContentPath(a, aHead);
  const bPath = piContentPath(b, bHead);
  return (
    aPath !== null &&
    bPath !== null &&
    aPath.length === bPath.length &&
    aPath.every((id, index) => id === bPath[index])
  );
}

function piContentPath(listing: PiSessionListing, headId: string | null): Array<string> | null {
  const path: Array<string> = [];
  const visited = new Set<string>();
  for (let id = headId; id !== null;) {
    const entry = listing.entries.get(id);
    if (entry === undefined || visited.has(id)) return null;
    visited.add(id);
    if (!entry.isLabel) path.push(id);
    id = entry.parentId;
  }
  return path;
}

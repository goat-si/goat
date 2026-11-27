import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { PiSessionEntry, PiSessionListing } from "./entries.ts";
import { piRecordField, piRecordString } from "./rpc.ts";

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_CACHED_ENTRIES = 4096;
const MAX_ENTRY_ID_LENGTH = 512;
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

interface Entry {
  readonly id: string;
  readonly parentId: string | null;
  readonly isUser: boolean;
  readonly isLabel: boolean;
  readonly timestamp: number | null;
}

const scanSessionJsonl = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  file: string,
  visit: (entry: Entry) => void,
  account: (bytes: number) => Effect.Effect<void, ProviderAdapter.ProviderAdapterProtocolError>,
  onSkip: () => void,
) {
  const line = new Uint8Array(MAX_LINE_BYTES);
  const decoder = new TextDecoder();
  let size = 0;
  let overflow = false;
  let skipped = 0;
  const finishLine = () => {
    if (!overflow && size > 0) {
      const decoded = decodeLine(decoder.decode(line.subarray(0, size)));
      if (Option.isNone(decoded)) {
        skipped++;
        onSkip();
      } else {
        const record = decoded.value;
        const id = piRecordString(record, "id");
        const parentId = piRecordField(record, "parentId");
        if (
          piRecordField(record, "type") !== "session" &&
          id !== undefined &&
          id.length <= MAX_ENTRY_ID_LENGTH &&
          (parentId === null ||
            (typeof parentId === "string" && parentId.length <= MAX_ENTRY_ID_LENGTH))
        ) {
          const timestamp = piRecordString(record, "timestamp");
          visit({
            id,
            parentId,
            isUser:
              piRecordField(record, "type") === "message" &&
              piRecordString(piRecordField(record, "message"), "role") === "user",
            isLabel: piRecordField(record, "type") === "label",
            timestamp:
              timestamp === undefined
                ? null
                : Option.getOrNull(Option.map(DateTime.make(timestamp), DateTime.toEpochMillis)),
          });
        }
      }
    }
    size = 0;
    overflow = false;
  };
  yield* fs.stream(file, { chunkSize: 16 * 1024 }).pipe(
    Stream.runForEach((chunk) =>
      account(chunk.length).pipe(
        Effect.andThen(
          Effect.sync(() => {
            let offset = 0;
            while (offset < chunk.length) {
              const newline = chunk.indexOf(10, offset);
              const end = newline < 0 ? chunk.length : newline;
              const count = end - offset;
              if (!overflow) {
                if (size + count > MAX_LINE_BYTES) {
                  overflow = true;
                  skipped++;
                  onSkip();
                } else {
                  line.set(chunk.subarray(offset, end), size);
                  size += count;
                }
              }
              if (newline < 0) break;
              finishLine();
              offset = newline + 1;
            }
          }),
        ),
      ),
    ),
  );
  if (size > 0 || overflow) finishLine();
  return skipped;
});

export const inspectSessionJsonl = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  file: string,
  targetId: string,
  boundaryId: string,
  account: (bytes: number) => Effect.Effect<void, ProviderAdapter.ProviderAdapterProtocolError>,
  onSkip: () => void,
) {
  const cache = new Map<string, Entry>();
  let leaf: Entry | undefined;
  let target: Entry | undefined;
  let boundary: Entry | undefined;
  let targetCount = 0;
  let boundaryCount = 0;
  let count = 0;
  const skipped = yield* scanSessionJsonl(
    fs,
    file,
    (entry) => {
      count++;
      leaf = entry;
      if (entry.id === targetId) {
        target = entry;
        targetCount++;
      }
      if (entry.id === boundaryId) {
        boundary = entry;
        boundaryCount++;
      }
      if (cache.size >= MAX_CACHED_ENTRIES && !cache.has(entry.id)) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(entry.id, entry);
    },
    account,
    onSkip,
  );
  const lookup = Effect.fnUntraced(function* (id: string) {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    let result: Entry | undefined;
    let hits = 0;
    yield* scanSessionJsonl(
      fs,
      file,
      (entry) => {
        if (entry.id === id) {
          result = entry;
          hits++;
        }
      },
      account,
      onSkip,
    );
    return hits === 1 ? result : undefined;
  });
  const walk = Effect.fnUntraced(function* (
    start: Entry | undefined,
    stop: string,
    accept: (entry: Entry) => boolean,
  ) {
    let current = start;
    for (let steps = 0; steps <= count && current !== undefined; steps++) {
      if (current.id === stop) return true;
      if (!accept(current) || current.parentId === null) return false;
      current = yield* lookup(current.parentId);
    }
    return false;
  });
  return {
    leaf,
    target: targetCount === 1 ? target : undefined,
    boundary: boundaryCount === 1 ? boundary : undefined,
    skipped,
    walk,
  };
});

export const readBoundedSessionJsonl = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  file: string,
  account: (bytes: number) => Effect.Effect<void, ProviderAdapter.ProviderAdapterProtocolError>,
  onSkip: () => void,
): Effect.fn.Return<PiSessionListing, ProviderAdapter.ProviderAdapterProtocolError | unknown> {
  const entries = new Map<string, PiSessionEntry>();
  let leafId: string | null = null;
  yield* scanSessionJsonl(
    fs,
    file,
    (entry) => {
      entries.set(entry.id, {
        parentId: entry.parentId,
        isUserMessage: entry.isUser,
        isLabel: entry.isLabel,
        timestamp: entry.timestamp,
      });
      leafId = entry.id;
    },
    account,
    onSkip,
  );
  return { entries, leafId };
});

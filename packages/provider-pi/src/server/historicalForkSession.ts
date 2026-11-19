import type { ProviderDriverKind } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { piSessionListing, walkPiBranch } from "./entries.ts";
import type { PiForkBoundary } from "./forkBoundary.ts";
import { piRecordField, piRecordString } from "./rpc.ts";

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export const findHistoricalForkSession = Effect.fn("PiAdapter.findHistoricalForkSession")(
  function* (
    currentFile: string,
    boundary: Extract<PiForkBoundary, { type: "entry" }>,
    driver: ProviderDriverKind,
  ) {
    const fail = (detail: string) =>
      new ProviderAdapter.ProviderAdapterProtocolError({
        driver,
        detail: `Cannot recover Pi fork session: ${detail}`,
      });
    const target = boundary.target;
    const targetId =
      target?.nativeTurnRef?.strength === "strong" ? target.nativeTurnRef.nativeId : null;
    if (
      targetId == null ||
      target?.startedAt == null ||
      target.completedAt == null ||
      boundary.turn.completedAt == null
    ) {
      return yield* fail("missing turn entry or timestamps");
    }
    const from = DateTime.toEpochMillis(target.startedAt);
    const between = DateTime.toEpochMillis(target.completedAt);
    const to = DateTime.toEpochMillis(boundary.turn.completedAt);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.dirname(currentFile);
    const entries = yield* fs
      .readDirectoryEntries(directory)
      .pipe(Effect.mapError(() => fail("session directory is unreadable")));
    const files = entries
      .filter((entry) => entry.type === "File" && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(directory, entry.name))
      .filter((file) => file !== currentFile);
    if (files.length > 256) return yield* fail("too many sibling session files");
    const matches: string[] = [];
    for (const file of files) {
      const stat = yield* fs
        .stat(file)
        .pipe(Effect.mapError(() => fail("a sibling session is unreadable")));
      if (Number(stat.size) > 4 * 1024 * 1024)
        return yield* fail("a sibling session exceeds the recovery limit");
      const text = yield* fs
        .readFileString(file)
        .pipe(Effect.mapError(() => fail("a sibling session is unreadable")));
      const records: unknown[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const decoded = decodeLine(line);
        if (Option.isNone(decoded)) return yield* fail("a sibling session is malformed");
        const record = decoded.value;
        if (
          piRecordField(record, "type") !== "session" &&
          piRecordString(record, "id") !== undefined
        )
          records.push(record);
      }
      const last = records.at(-1);
      const listing = piSessionListing({
        entries: records,
        leafId: last === undefined ? null : piRecordString(last, "id"),
      });
      if (listing === null) return yield* fail("a sibling session is malformed");
      const inWindow = (id: string, low: number, high: number) => {
        const entry = listing.entries.get(id);
        return (
          entry?.isUserMessage === true &&
          entry.timestamp !== null &&
          entry.timestamp >= low &&
          entry.timestamp <= high
        );
      };
      if (
        inWindow(targetId, from, between) &&
        inWindow(boundary.entryId, between, to) &&
        walkPiBranch(listing.entries, listing.leafId, boundary.entryId)?.reachedStop === true &&
        walkPiBranch(listing.entries, boundary.entryId, targetId)?.reachedStop === true
      )
        matches.push(file);
    }
    if (matches.length !== 1)
      return yield* fail(
        matches.length === 0 ? "no verified sibling session" : "multiple matching sibling sessions",
      );
    const match = matches[0];
    if (match === undefined) return yield* fail("no verified sibling session");
    return match;
  },
);

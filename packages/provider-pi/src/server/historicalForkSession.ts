// @effect-diagnostics nodeBuiltinImport:off -- Effect FileSystem has no streaming directory iterator.
import * as NodeFSP from "node:fs/promises";
import type { ProviderDriverKind } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PiForkBoundary } from "./forkBoundary.ts";
import { inspectSessionJsonl } from "./sessionJsonlScan.ts";

export const findHistoricalForkSession = Effect.fn("PiAdapter.findHistoricalForkSession")(
  function* (
    currentFile: string,
    boundary: Extract<PiForkBoundary, { type: "entry" }>,
    driver: ProviderDriverKind,
    includeCurrent = false,
    singleTarget = false,
    allowLater = false,
    onlyFile?: string,
  ) {
    const fail = (detail: string) =>
      new ProviderAdapter.ProviderAdapterProtocolError({
        driver,
        detail: `Cannot recover Pi fork session: ${detail}`,
      });
    const target = boundary.target;
    const targetId =
      target?.nativeTurnRef?.strength === "strong" ? target.nativeTurnRef.nativeId : null;
    if (targetId == null || target == null) return yield* fail("missing captured target entry");
    const from = target.startedAt === null ? undefined : DateTime.toEpochMillis(target.startedAt);
    const between =
      target.completedAt === null ? undefined : DateTime.toEpochMillis(target.completedAt);
    const to =
      boundary.turn.completedAt === null
        ? undefined
        : DateTime.toEpochMillis(boundary.turn.completedAt);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.dirname(currentFile);
    const realDirectory = yield* fs
      .realPath(directory)
      .pipe(Effect.mapError(() => fail("session directory is unreadable")));
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => NodeFSP.opendir(realDirectory),
            catch: () => fail("session directory is unreadable"),
          }),
          (dir) =>
            Effect.tryPromise({
              try: () => dir.close(),
              catch: () => fail("session directory could not be closed"),
            }).pipe(Effect.ignore),
        );
        let match: string | undefined;
        let unreadable = 0;
        let skipped = 0;
        while (true) {
          const entry = yield* Effect.tryPromise({
            try: () => handle.read(),
            catch: () => fail("session directory is unreadable"),
          });
          if (entry === null) break;
          if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
          const file = path.join(directory, entry.name);
          if (
            (!includeCurrent && file === currentFile) ||
            (onlyFile !== undefined && file !== onlyFile)
          )
            continue;
          const result = yield* Effect.result(
            inspectSessionJsonl(fs, file, targetId, boundary.entryId),
          );
          if (result._tag === "Failure") {
            unreadable++;
            continue;
          }
          const listing = result.success;
          skipped += listing.skipped;
          const inWindow = (
            item: typeof listing.target,
            low: number | undefined,
            high: number | undefined,
          ) =>
            item?.isUser === true &&
            (low === undefined || (item.timestamp !== null && item.timestamp >= low)) &&
            (high === undefined || (item.timestamp !== null && item.timestamp <= high));
          if (
            !inWindow(listing.target, from, between) ||
            (!singleTarget && !inWindow(listing.boundary, between, to))
          )
            continue;
          const tail = yield* Effect.result(
            listing.walk(
              listing.leaf,
              boundary.entryId,
              (item) =>
                !singleTarget ||
                !includeCurrent ||
                allowLater ||
                !item.isUser ||
                inWindow(item, from, between),
            ),
          );
          if (tail._tag === "Failure") {
            unreadable++;
            continue;
          }
          if (!tail.success) continue;
          const ancestors = yield* Effect.result(
            listing.walk(listing.boundary, targetId, () => true),
          );
          if (ancestors._tag === "Failure") {
            unreadable++;
            continue;
          }
          if (!ancestors.success) continue;
          if (match !== undefined) return yield* fail("multiple matching sibling sessions");
          match = file;
        }
        if (match === undefined)
          return yield* fail(
            `no verified sibling session (${unreadable} unreadable files, ${skipped} skipped lines)`,
          );
        return match;
      }),
    );
  },
);

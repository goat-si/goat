// @effect-diagnostics nodeBuiltinImport:off -- Effect FileSystem has no streaming directory iterator.
import * as NodeFSP from "node:fs/promises";
import type { ProviderDriverKind } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PiForkBoundary } from "./forkBoundary.ts";
import { inspectSessionJsonl } from "./sessionJsonlScan.ts";

const MAX_SCANNED_FILES = 2048;
const MAX_SCANNED_BYTES = 512 * 1024 * 1024;
const MAX_SCAN_DURATION_MS = 10_000;

interface ScanLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxDurationMs: number;
}

interface ScanBudget {
  readonly limits: ScanLimits;
  readonly stats: { files: number; bytes: number; unreadable: number; skipped: number };
  startedAt: number | undefined;
}

export const makeHistoricalScanBudget = (
  limits: ScanLimits = {
    maxFiles: MAX_SCANNED_FILES,
    maxBytes: MAX_SCANNED_BYTES,
    maxDurationMs: MAX_SCAN_DURATION_MS,
  },
): ScanBudget => ({
  limits,
  stats: { files: 0, bytes: 0, unreadable: 0, skipped: 0 },
  startedAt: undefined,
});

const filenameTimestamp = (name: string) => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z/u.exec(name);
  if (match === null) return undefined;
  const parsed = DateTime.make(`${match[1]}:${match[2]}:${match[3]}.${match[4]}Z`);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : undefined;
};

export const findHistoricalForkSession = Effect.fn("PiAdapter.findHistoricalForkSession")(
  function* (
    currentFile: string,
    boundary: Extract<PiForkBoundary, { type: "entry" }>,
    driver: ProviderDriverKind,
    includeCurrent = false,
    singleTarget = false,
    allowLater = false,
    onlyFile?: string,
    limits?: ScanLimits,
    sharedBudget?: ScanBudget,
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
    const budget = sharedBudget ?? makeHistoricalScanBudget(limits);
    const stats = budget.stats;
    const now = yield* Clock.currentTimeMillis;
    budget.startedAt ??= now;
    const remainingMs = budget.limits.maxDurationMs - (now - budget.startedAt);
    const limit = (kind: string) =>
      fail(
        `Couldn't verify which session this turn belongs to within the ${kind} scan limit; fork from a newer turn or open the session file (${stats.files} files, ${stats.bytes} bytes, ${stats.unreadable} unreadable files, ${stats.skipped} skipped lines)`,
      );
    const account = (bytes: number) =>
      Effect.suspend(() => {
        stats.bytes += bytes;
        return stats.bytes > budget.limits.maxBytes ? Effect.fail(limit("bytes")) : Effect.void;
      });
    if (remainingMs <= 0) return yield* limit("time");
    const scan = Effect.scoped(
      Effect.gen(function* () {
        const realDirectory = yield* fs
          .realPath(directory)
          .pipe(Effect.mapError(() => fail("session directory is unreadable")));
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
        const files: string[] = [];
        while (true) {
          const entry = yield* Effect.tryPromise({
            try: () => handle.read(),
            catch: () => fail("session directory is unreadable"),
          });
          if (entry === null) break;
          if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
          const file = path.join(directory, entry.name);
          stats.files++;
          if (stats.files > budget.limits.maxFiles) return yield* limit("files");
          if (
            (!includeCurrent && file === currentFile) ||
            (onlyFile !== undefined && file !== onlyFile)
          )
            continue;
          files.push(file);
        }
        files.sort((a, b) => {
          const targetTime = from ?? between;
          const ta = filenameTimestamp(path.basename(a));
          const tb = filenameTimestamp(path.basename(b));
          const da =
            targetTime === undefined || ta === undefined ? Infinity : Math.abs(ta - targetTime);
          const db =
            targetTime === undefined || tb === undefined ? Infinity : Math.abs(tb - targetTime);
          return da === db ? (a < b ? -1 : a > b ? 1 : 0) : da - db;
        });
        for (const file of files) {
          const result = yield* Effect.result(
            inspectSessionJsonl(fs, file, targetId, boundary.entryId, account, () => {
              stats.skipped++;
            }),
          );
          if (result._tag === "Failure") {
            if (result.failure._tag === "ProviderAdapterProtocolError")
              return yield* result.failure;
            stats.unreadable++;
            continue;
          }
          const listing = result.success;
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
            if (tail.failure._tag === "ProviderAdapterProtocolError") return yield* tail.failure;
            stats.unreadable++;
            continue;
          }
          if (!tail.success) continue;
          const ancestors = yield* Effect.result(
            listing.walk(listing.boundary, targetId, () => true),
          );
          if (ancestors._tag === "Failure") {
            if (ancestors.failure._tag === "ProviderAdapterProtocolError")
              return yield* ancestors.failure;
            stats.unreadable++;
            continue;
          }
          if (!ancestors.success) continue;
          if (match !== undefined) return yield* fail("multiple matching sibling sessions");
          match = file;
        }
        if (match === undefined)
          return yield* fail(
            `no verified sibling session (${stats.unreadable} unreadable files, ${stats.skipped} skipped lines)`,
          );
        return match;
      }),
    );
    const result = yield* scan.pipe(Effect.timeoutOption(Duration.millis(remainingMs)));
    if (Option.isNone(result)) return yield* limit("time");
    return result.value;
  },
);

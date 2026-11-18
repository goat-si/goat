import * as NodeBuffer from "node:buffer";
import { writeFileStringAtomically } from "@goat/shared/atomicWrite";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";

const WATCH_SWEEP_BUDGET = 64;
const CURSOR_MAX_BYTES = 4_096;

const isWatchSweepKey = (key: string) => {
  if (/[\p{Cc}\p{Cs}]/u.test(key)) return false;
  // Same fields as lifeKey: normalized host/repository#number, thread ID and ISO start time.
  const match = /^([^/\s#]+)\/(.+?)#([1-9]\d*) (.+) (\S+)$/u.exec(key);
  if (match === null) return false;
  const [, host = "", repository = "", number, threadId = "", startedAt = ""] = match;
  const time = DateTime.make(startedAt);
  return (
    host === host.toLowerCase() &&
    repository === repository.trim().toLowerCase() &&
    threadId === threadId.trim() &&
    Number.isSafeInteger(Number(number)) &&
    Option.isSome(time) &&
    DateTime.formatIso(time.value) === startedAt
  );
};

export const watchSweepPage = <Item extends { readonly key: string }>(
  work: ReadonlyArray<Item>,
  after?: string,
) => {
  const sorted = work.toSorted((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
  // If the remainder disappeared between passes, start the next cycle now.
  const start =
    after === undefined
      ? 0
      : Math.max(
          0,
          sorted.findIndex(({ key }) => key > after),
        );
  const end = start + WATCH_SWEEP_BUDGET;
  const items = sorted.slice(start, end);
  return { items, after: end < sorted.length ? items.at(-1)?.key : undefined };
};

export const makeWatchSweepCursor = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(stateDir, "pull-request-watch-cursor");
  const bytes = yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(filePath, { flag: "r" });
      const buffer = new Uint8Array(CURSOR_MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = yield* file.read(buffer.subarray(length));
        if (read === 0) break;
        length += read;
      }
      return buffer.subarray(0, length);
    }),
  ).pipe(
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound"
        ? Effect.void
        : Effect.logWarning("Failed to read pull request watch sweep cursor", { cause }),
    ),
  );
  let saved =
    bytes === undefined || bytes.length === 0
      ? undefined
      : yield* Effect.try(() => {
          if (bytes.length > CURSOR_MAX_BYTES) {
            throw new Error(`Cursor exceeds ${CURSOR_MAX_BYTES} bytes`);
          }
          const key = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
          if (!isWatchSweepKey(key)) throw new Error("Invalid watch key");
          return key;
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Ignoring invalid pull request watch sweep cursor", { cause }).pipe(
              Effect.as(undefined),
            ),
          ),
        );
  let after = saved;
  let warnedAboutInvalidWrite = false;

  const complete = Effect.fn("PullRequestWatchSweepCursor.complete")(function* (
    next: string | undefined,
  ) {
    after = next;
    if (
      next !== undefined &&
      (NodeBuffer.Buffer.byteLength(next) > CURSOR_MAX_BYTES || !isWatchSweepKey(next))
    ) {
      if (!warnedAboutInvalidWrite) {
        warnedAboutInvalidWrite = true;
        yield* Effect.logWarning(
          "Cannot persist pull request watch sweep cursor outside storage format",
        );
      }
      next = undefined;
    }
    if (next === saved) return;
    // The server owns stateDir exclusively and the reactor serializes sweeps.
    yield* writeFileStringAtomically({
      filePath,
      contents: next ?? "",
      reuseStagingFile: true,
      replaceSymlink: true,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.tap(() =>
        Effect.sync(() => {
          saved = next;
        }),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to save pull request watch sweep cursor", { cause }),
      ),
    );
  });
  return {
    get after() {
      return after;
    },
    complete,
  };
});

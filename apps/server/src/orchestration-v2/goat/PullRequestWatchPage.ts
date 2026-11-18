import { writeFileStringAtomically } from "@goat/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";

const WATCH_SWEEP_BUDGET = 64;

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
  let saved = yield* fs.readFileString(filePath).pipe(
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound"
        ? Effect.void
        : Effect.logWarning("Failed to read pull request watch sweep cursor", { cause }),
    ),
    Effect.map((key) => key || undefined),
  );
  let after = saved;

  const complete = Effect.fn("PullRequestWatchSweepCursor.complete")(function* (
    next: string | undefined,
  ) {
    after = next;
    if (next === saved) return;
    yield* writeFileStringAtomically({ filePath, contents: next ?? "" }).pipe(
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

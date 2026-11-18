import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import { makeWatchSweepCursor, watchSweepPage } from "./PullRequestWatchPage.ts";

const startedAt = "2026-11-18T10:00:00.000Z";
const watchKey = (threadId: string) => `github.com/goat-si/goat#21 ${threadId} ${startedAt}`;
const layer = ServerConfig.layerTest(process.cwd(), { prefix: "goat-watch-sweep-cursor-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("pull request sweep cursor", (it) => {
  it.effect.each([
    ["a NUL in a key", `${watchKey("watch-11")}\0`],
    ["a value without the key fields", "github.com/goat-si/goat#21 watch-11"],
    ["a 1 MiB file", watchKey("w".repeat(1024 * 1024))],
  ] as const)("starts on the first page and logs once for %s", ([, contents]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(path.join(stateDir, "pull-request-watch-cursor"), contents);
      const warnings: unknown[] = [];
      const cursor = yield* makeWatchSweepCursor.pipe(
        Effect.provide(Logger.layer([Logger.make(({ message }) => warnings.push(message))])),
      );
      const work = Array.from({ length: 65 }, (_, index) => ({
        key: watchKey(`watch-${String(index).padStart(2, "0")}`),
      }));

      assert.equal(watchSweepPage(work, cursor.after).items[0]?.key, work[0]?.key);
      assert.isTrue(cursor.after === undefined);
      assert.lengthOf(warnings, 1);
    }),
  );

  it.effect("keeps paging in memory when the cursor exceeds the byte limit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const filePath = path.join(stateDir, "pull-request-watch-cursor");
      const cursor = yield* makeWatchSweepCursor;
      yield* cursor.complete(watchKey("watch-11"));
      const tooLarge = watchKey("é".repeat(2_048));

      yield* cursor.complete(tooLarge);

      assert.equal(cursor.after, tooLarge);
      assert.equal((yield* fs.stat(filePath)).size, 0n);
      const restarted = yield* makeWatchSweepCursor;
      assert.isUndefined(restarted.after);
    }),
  );

  it.effect("reuses the staging path left by an interrupted cursor write", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const filePath = path.join(stateDir, "pull-request-watch-cursor");
      const stagingPath = `${filePath}.staging`;
      yield* fs.writeFileString(filePath, watchKey("watch-11"));
      yield* fs.writeFileString(stagingPath, watchKey("watch-22"));

      const cursor = yield* makeWatchSweepCursor;
      assert.equal(cursor.after, watchKey("watch-11"));
      yield* cursor.complete(watchKey("watch-33"));

      assert.isFalse(yield* fs.exists(stagingPath));
      const restarted = yield* makeWatchSweepCursor;
      assert.equal(restarted.after, watchKey("watch-33"));
    }),
  );
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import {
  initRepoWithCommit,
  layerServerConfig,
  layerTest,
  makeTmpDir,
  writeTextFile,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("branch change totals after a failed untracked listing", (it) => {
  it.effect("do not list untracked files again on every status read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeTmpDir("git-untracked-totals-");
      yield* initRepoWithCommit(cwd);
      const many = path.join(cwd, "many");
      yield* fs.makeDirectory(many);
      yield* Effect.forEach(
        Array.from({ length: 5_001 }, (_, index) => index),
        (index) => fs.writeFileString(path.join(many, `file-${index}`), ""),
        { concurrency: 64, discard: true },
      );

      let listings = 0;
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.suspend(() => {
          if (
            ChildProcess.isStandardCommand(command) &&
            command.args.includes("ls-files") &&
            command.args.includes("--others")
          )
            listings++;
          return delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(layerServerConfig),
      );
      const read = driver.statusDetailsLocal(cwd, { includeBranchChanges: true });

      assert.strictEqual((yield* read).branchChanges, undefined, "too many files to count");
      assert.strictEqual(listings, 1);
      yield* read;
      yield* read;
      assert.strictEqual(listings, 1, "the failed listing is not repeated within the backoff");

      yield* TestClock.adjust("1 minute");
      yield* read;
      assert.strictEqual(listings, 2, "it is retried once the backoff passes");
      yield* TestClock.adjust("1 minute");
      yield* read;
      assert.strictEqual(listings, 2, "and the next backoff is longer");

      // A change at the untracked-roots level scans again at once and counts again.
      yield* fs.remove(many, { recursive: true });
      yield* writeTextFile(cwd, "notes.txt", "one\ntwo\n");
      const status = yield* read;
      assert.strictEqual(listings, 3);
      assert.deepStrictEqual(status.branchChanges, { baseRef: null, insertions: 2, deletions: 0 });
    }),
  );
});

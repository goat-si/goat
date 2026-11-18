import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  git,
  initRepoWithCommit,
  layerTest,
  makeTmpDir,
  writeTextFile,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("change totals index", (it) => {
  it.effect("reads Changes totals without rewriting the real index for stat-dirty files", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* writeTextFile(cwd, "tracked.txt", "same content\n");
      yield* git(cwd, ["add", "tracked.txt"]);
      yield* git(cwd, ["commit", "-m", "add tracked file"]);
      yield* fileSystem.utimes(path.join(cwd, "tracked.txt"), 1_000_000_000, 1_000_000_000);
      const indexPath = path.join(cwd, ".git", "index");
      const originalIndex = yield* fileSystem.readFile(indexPath);

      const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });

      assert.strictEqual(status.branchChanges?.insertions, 0);
      assert.strictEqual(status.branchChanges?.deletions, 0);
      // Writing the index takes index.lock, which makes concurrent user Git writes fail.
      assert.deepStrictEqual(yield* fileSystem.readFile(indexPath), originalIndex);
    }),
  );
});

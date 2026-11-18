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

it.layer(layerTest)("untracked size limit", (it) => {
  it.effect("reports status without counting oversized untracked files", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* git(cwd, ["init", "-b", "main"]);
      yield* writeTextFile(cwd, "large.data", "");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.truncate(path.join(cwd, "large.data"), 257 * 1024 * 1024);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
      assert.isTrue(status.isRepo);
      assert.strictEqual(status.branch, "main");
      assert.isUndefined(status.branchChanges);
    }),
  );
  it.effect("counts totals when a large staged deletion remains on disk", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      yield* writeTextFile(cwd, "asset.data", "old\n");
      yield* git(cwd, ["add", "asset.data"]);
      yield* git(cwd, ["commit", "-m", "add asset"]);
      yield* git(cwd, ["rm", "--cached", "asset.data"]);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.truncate(path.join(cwd, "asset.data"), 257 * 1024 * 1024);
      yield* writeTextFile(cwd, "ordinary.txt", "new\n");
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
      assert.deepStrictEqual(status.branchChanges, { baseRef: null, insertions: 1, deletions: 1 });
      const preview = yield* driver.getReviewDiffPreview({ cwd, metadataOnly: true });
      assert.deepStrictEqual(
        preview.sources.find((source) => source.kind === "working-tree")?.files,
        [
          { path: "asset.data", previousPath: null, additions: 0, deletions: 1 },
          { path: "ordinary.txt", previousPath: null, additions: 1, deletions: 0 },
        ],
      );
    }),
  );
});

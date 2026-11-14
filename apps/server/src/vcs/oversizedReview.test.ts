import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { initRepoWithCommit, layerTest, makeTmpDir, writeTextFile } from "./testing/gitFixture.ts";

it.layer(layerTest)("oversized review files", (it) => {
  it.effect("keeps an oversized untracked file out of the review diff", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      yield* writeTextFile(cwd, "README.md", "# tracked change\n");
      yield* writeTextFile(cwd, "ordinary.txt", "new\n");
      yield* writeTextFile(cwd, "large.data", "");
      // Sparse: the logical size is over the budget without allocating it.
      yield* fileSystem.truncate(pathService.join(cwd, "large.data"), 257 * 1024 * 1024);

      const preview = yield* driver.getReviewDiffPreview({ cwd, metadataOnly: true });

      const source = preview.sources.find((source) => source.kind === "working-tree")!;
      assert.isUndefined(source.files);
      assert.isUndefined(source.patchesDeferred);
      assert.isTrue(source.truncated);
      assert.include(source.diff, "+# tracked change");
      assert.include(source.diff, "b/ordinary.txt");
      assert.notInclude(source.diff, "large.data");
    }),
  );
});

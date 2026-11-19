import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  layerTest,
  makeTmpDir,
  writeTextFile,
  git,
  initRepoWithCommit,
} from "./testing/gitFixture.ts";
it.layer(layerTest)("nested repository review", (it) => {
  it.effect("keeps the review working beside a nested repository with no commits", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["init", "scaffold"]);
      const committed = `${cwd}/committed`;
      yield* (yield* FileSystem.FileSystem).makeDirectory(committed);
      yield* initRepoWithCommit(committed);
      yield* writeTextFile(cwd, "README.md", "# tracked change\n");
      yield* writeTextFile(cwd, "untracked.txt", "untracked contents\n");

      const preview = yield* driver.getReviewDiffPreview({ cwd, ignoreWhitespace: false });
      const diff = preview.sources.find((source) => source.kind === "working-tree")?.diff ?? "";

      assert.include(diff, "+# tracked change");
      assert.include(diff, "+untracked contents");
      assert.notInclude(diff, "scaffold");
      assert.include(diff, "diff --git a/committed b/committed");

      const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
      assert.deepStrictEqual(status.branchChanges, {
        baseRef: null,
        insertions: 3,
        deletions: 1,
      });
    }),
  );
});

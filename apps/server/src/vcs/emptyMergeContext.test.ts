import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  git,
  initRepoWithCommit,
  layerTest,
  makeTmpDir,
  writeTextFile,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("merge context", (it) => {
  it.effect("reports a merge resolved to HEAD's tree as committable", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      // A branch named MERGE_HEAD is not a merge in progress.
      yield* git(cwd, ["branch", "MERGE_HEAD"]);
      assert.isNull(yield* driver.prepareCommitContext(cwd, undefined, { includePatch: false }));
      yield* git(cwd, ["branch", "-D", "MERGE_HEAD"]);
      yield* git(cwd, ["checkout", "-b", "feature"]);
      yield* writeTextFile(cwd, "README.md", "feature version\n");
      yield* git(cwd, ["commit", "-am", "Feature"]);
      yield* git(cwd, ["checkout", initialBranch]);
      yield* writeTextFile(cwd, "README.md", "main version\n");
      yield* git(cwd, ["commit", "-am", "Main"]);
      const merge = yield* driver.execute({
        operation: "test.merge",
        cwd,
        args: ["merge", "feature"],
        allowNonZeroExit: true,
      });
      assert.equal(merge.exitCode, 1);
      yield* writeTextFile(cwd, "README.md", "main version\n");

      assert.isNotNull(yield* driver.prepareCommitContext(cwd, undefined, { includePatch: false }));
    }),
  );
});

// @effect-diagnostics nodeBuiltinImport:off - Git's state marker must remain present after rejection.
import * as NodeFS from "node:fs";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  git,
  initRepoWithCommit,
  layerTest,
  makeTmpDir,
  writeTextFile,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("selected commits", (it) => {
  it.effect.each([
    { operation: "cherry-pick", head: "CHERRY_PICK_HEAD" },
    { operation: "revert", head: "REVERT_HEAD" },
  ])("rejects selected-file commits during a $operation", ({ operation, head }) =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["checkout", "-b", "other"]);
      yield* writeTextFile(cwd, "README.md", "other version\n");
      yield* writeTextFile(cwd, "picked.txt", "picked\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "Other"]);
      if (operation === "cherry-pick") yield* git(cwd, ["checkout", initialBranch]);
      yield* writeTextFile(cwd, "README.md", "main version\n");
      yield* git(cwd, ["commit", "-am", "Main"]);
      const originalHead = yield* git(cwd, ["rev-parse", "HEAD"]);
      const result = yield* driver.execute({
        operation: `test.${operation}`,
        cwd,
        args: [operation, operation === "cherry-pick" ? "other" : "HEAD~1"],
        allowNonZeroExit: true,
      });
      assert.equal(result.exitCode, 1);
      yield* writeTextFile(cwd, "README.md", "resolved version\n");
      yield* git(cwd, ["add", "README.md"]);
      const gitDir = yield* git(cwd, ["rev-parse", "--absolute-git-dir"]);
      const selected = operation === "cherry-pick" ? "picked.txt" : "README.md";

      const commit = yield* driver
        .commit(cwd, "Partial", "", { stage: { filePaths: [selected] } })
        .pipe(Effect.result);

      assert.isTrue(Result.isFailure(commit), `Selected-file ${operation} commit succeeded`);
      assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), originalHead);
      assert.isTrue(NodeFS.existsSync(`${gitDir}/${head}`));
    }),
  );
});
